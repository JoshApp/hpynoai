/**
 * AudioCompositor — unified sound engine.
 *
 * Mirrors the visual compositor: layers + master bus + presets.
 * Replaces both AudioEngine (binaural/drone) and AmbientEngine (pad/noise/melody).
 *
 * Signal chain:
 *   layers → reverbSend → Tone.Reverb → masterGain
 *   layers → dryGain → masterGain
 *   masterGain → Tone.Compressor → output (analyzer → destination)
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from './types';
import { DEFAULT_AUDIO_PRESET, mergePreset } from './types';
import type { WorldInputs } from '../compositor/types';
import { log } from '../logger';

export class AudioCompositor {
  private layers: AudioLayer[] = [];
  private currentPreset: AudioPreset = { ...DEFAULT_AUDIO_PRESET };
  private isPlaying = false;
  private _stopTimer: ReturnType<typeof setTimeout> | null = null;

  // Master bus nodes
  private reverb: Tone.Reverb | null = null;
  private reverbSend: Tone.Gain | null = null;
  private dryGain: Tone.Gain | null = null;
  private masterGain: Tone.Gain | null = null;
  private compressor: Tone.Compressor | null = null;

  // Output destination (connects to existing analyzer → speakers)
  private output: GainNode | null = null;

  addLayer(layer: AudioLayer): void {
    // Replace existing layer with same name
    const existingIdx = this.layers.findIndex(l => l.name === layer.name);
    if (existingIdx >= 0) {
      const old = this.layers[existingIdx];
      try { old.stop(); old.dispose(); } catch { /* ok */ }
      this.layers.splice(existingIdx, 1);
    }
    this.layers.push(layer);
    // Connect + start if compositor is already running
    if (this.isPlaying && this.reverbSend && this.dryGain) {
      try {
        layer.connect(this.reverbSend, this.dryGain);
        layer.applyPreset(this.currentPreset, 0);
        layer.start();
      } catch (e) {
        log.warn('audio-compositor', `Layer ${layer.name} late-start failed`, e);
      }
    }
    log.info('audio-compositor', `Layer added: ${layer.name}`);
  }

  getLayer<T extends AudioLayer>(name: string): T | undefined {
    return this.layers.find(l => l.name === name) as T | undefined;
  }

  /**
   * Initialize the master bus and connect to the existing Web Audio graph.
   * @param output The GainNode to connect to (e.g., AudioEngine's masterGain → analyzer → destination)
   */
  async init(output: GainNode): Promise<void> {
    log.info('audio-compositor', `init called, pending stop timer=${!!this._stopTimer}, layers=${this.layers.length}`);
    // Cancel any pending disposal from a previous stop()
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
    this.output = output;

    // Share the existing AudioContext with Tone.js (they must use the same context)
    const rawCtx = output.context as AudioContext;
    Tone.setContext(rawCtx);
    await Tone.start();
    log.info('audio-compositor', `Tone.js using shared context, state: ${rawCtx.state}`);

    // Master gain → raw output
    this.masterGain = new Tone.Gain(0);
    // Bridge Tone.js to raw Web Audio — try Tone.connect, fall back to raw API
    try {
      Tone.connect(this.masterGain, output);
    } catch {
      // Fallback: access Tone's internal output node and connect directly
      (this.masterGain as unknown as { output: AudioNode }).output.connect(output);
    }
    log.info('audio-compositor', 'Master gain connected to output');

    // Dry path — higher initial gain for audibility
    this.dryGain = new Tone.Gain(0.6);
    this.dryGain.connect(this.masterGain);

    // Reverb send — start routed to dry (instant), connect reverb async (non-blocking)
    this.reverbSend = new Tone.Gain(0.4);
    this.reverbSend.connect(this.masterGain); // initially goes straight to master

    // Generate reverb impulse in background — doesn't block audio start
    try {
      this.reverb = new Tone.Reverb({
        decay: this.currentPreset.reverb.decay,
        wet: 1,
        preDelay: 0.08,
      });
      this.reverb.ready.then(() => {
        if (this.reverbSend && this.reverb && this.masterGain) {
          // Reroute: reverbSend → reverb → masterGain (instead of reverbSend → masterGain)
          this.reverbSend.disconnect();
          this.reverbSend.connect(this.reverb);
          this.reverb.connect(this.masterGain);
          log.info('audio-compositor', 'Reverb connected (async)');
        }
      }).catch(() => {
        log.warn('audio-compositor', 'Reverb generation failed');
      });
    } catch {
      log.warn('audio-compositor', 'Reverb creation failed');
    }

    log.info('audio-compositor', 'Init complete (reverb loading async)');
  }

  /** Start all layers (call after init, on session start) */
  start(preset?: Partial<AudioPreset>): void {
    if (this.isPlaying) return;
    this.isPlaying = true;

    if (preset) {
      this.currentPreset = mergePreset(this.currentPreset, preset);
    }

    // Start master at 0, fade in slowly (prevents click/pop on start)
    if (this.masterGain) {
      this.masterGain.gain.value = 0;
    }

    // Connect + start all layers with a 2s ramp (not instant)
    for (const layer of this.layers) {
      try {
        if (this.reverbSend && this.dryGain) {
          layer.connect(this.reverbSend, this.dryGain);
        }
        layer.applyPreset(this.currentPreset, 2); // 2s ramp, not 0 — prevents transient spikes
        layer.start();
        log.info('audio-compositor', `Layer started: ${layer.name}`);
      } catch (e) {
        log.warn('audio-compositor', `Layer ${layer.name} failed to start`, e);
      }
    }

    // Fade in master over 3s (on top of layer-level 2s ramp = smooth start)
    this.masterGain?.gain.rampTo(this._userVolume, 3);

    log.info('audio-compositor', `Started, ramping to ${this._userVolume}`);
  }

  /** Smoothly transition to a new preset (on stage change) */
  applyPreset(partial: Partial<AudioPreset>, rampTime = 3): void {
    this.currentPreset = mergePreset(this.currentPreset, partial);

    // Reverb
    if (this.reverbSend) this.reverbSend.gain.rampTo(this.currentPreset.reverb.wet, rampTime);
    if (this.dryGain) this.dryGain.gain.rampTo(1 - this.currentPreset.reverb.wet, rampTime);

    // Master volume controlled by setMasterVolume (settings slider) — not by presets

    // All layers
    for (const layer of this.layers) {
      layer.applyPreset(this.currentPreset, rampTime);
    }
  }

  private _duckLevel = 1;
  private _userVolume = 0.5;  // from settings slider — the single source of truth

  /** Set user volume (from settings). This is the base volume everything multiplies against. */
  setMasterVolume(v: number): void {
    this._userVolume = v;
  }

  /** Update each frame — breath modulation, voice ducking */
  update(inputs: WorldInputs, dt: number): void {
    if (!this.isPlaying) return;

    // Voice ducking
    const voiceActive = inputs.voiceEnergy > 0.05;
    const duckTarget = voiceActive ? 0.45 : 1;
    this._duckLevel += (duckTarget - this._duckLevel) * (voiceActive ? 0.08 : 0.03);

    // Master gain = user volume × duck level (simple, no preset override)
    if (this.masterGain) {
      this.masterGain.gain.rampTo(this._userVolume * this._duckLevel, 0.15);
    }

    for (const layer of this.layers) {
      layer.update(inputs, dt);
    }
  }

  /**
   * Silence dip — drop ambient to near-silence, then slowly return.
   * Creates perceived depth: silence makes the sound feel bigger when it comes back.
   * @param dipDuration Seconds of near-silence
   * @param returnDuration Seconds to fade back in
   */
  silenceDip(dipDuration = 2, returnDuration = 4): void {
    if (!this.masterGain || !this.isPlaying) return;
    const currentVol = this.currentPreset.master.volume * this._duckLevel;
    this.masterGain.gain.rampTo(currentVol * 0.05, 1); // fast drop to 5%
    setTimeout(() => {
      if (this.masterGain && this.isPlaying) {
        this.masterGain.gain.rampTo(currentVol, returnDuration); // slow return
      }
    }, dipDuration * 1000);
  }

  /** Resolve to a warm final chord before stopping (musical ending) */
  resolve(rootNote = 48): void {
    if (!this.isPlaying) return;
    // Resolve pad to a bright major chord
    this.applyPreset({
      pad: { chord: [rootNote, rootNote + 4, rootNote + 7, rootNote + 12], filterMax: 1800, warmth: 0.4, chorusRate: 0.2, volume: 0.25 },
      melody: { rootNote, volume: 0, tempo: 0 },
      noise: { type: 'pink', filterFreq: 200, volume: 0.05 },
      drone: { rootNote: rootNote - 12, harmonicity: 2, modIndex: 1, volume: 0.1 },
      reverb: { decay: 6, wet: 0.8 },
    } as Partial<AudioPreset>, 2);
  }

  /** Stop all layers with fade */
  stop(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;

    // Stop + dispose layers immediately (they fade internally)
    for (const layer of this.layers) {
      try { layer.stop(3); } catch { /* ok */ }
    }
    const layersToDispose = [...this.layers];
    this.layers = [];

    if (this.masterGain) {
      this.masterGain.gain.rampTo(0, 3);
    }

    // Dispose bus nodes after fade
    if (this._stopTimer) clearTimeout(this._stopTimer);
    const busNodes = {
      reverb: this.reverb, reverbSend: this.reverbSend,
      dryGain: this.dryGain, compressor: this.compressor,
      masterGain: this.masterGain,
    };
    this.reverb = null;
    this.reverbSend = null;
    this.dryGain = null;
    this.compressor = null;
    this.masterGain = null;

    this._stopTimer = setTimeout(() => {
      this._stopTimer = null;
      for (const layer of layersToDispose) {
        try { layer.dispose(); } catch { /* ok */ }
      }
      busNodes.reverb?.dispose();
      busNodes.reverbSend?.dispose();
      busNodes.dryGain?.dispose();
      busNodes.compressor?.dispose();
      busNodes.masterGain?.dispose();
    }, 5000);

    log.info('audio-compositor', 'Stopped');
  }

  dispose(): void {
    this.stop();
    this.layers = [];
  }
}
