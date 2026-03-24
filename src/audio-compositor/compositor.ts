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

    // Dry path (always works)
    this.dryGain = new Tone.Gain(0.5);
    this.dryGain.connect(this.masterGain);

    // Reverb send (optional — may fail on some browsers)
    this.reverbSend = new Tone.Gain(0.5);
    try {
      this.reverb = new Tone.Reverb({
        decay: this.currentPreset.reverb.decay,
        wet: 1,
        preDelay: 0.08,
      });
      await this.reverb.ready;
      this.reverbSend.connect(this.reverb);
      this.reverb.connect(this.masterGain);
      log.info('audio-compositor', 'Reverb initialized');
    } catch (e) {
      // Reverb failed — route reverb send directly to master (no reverb but still audible)
      log.warn('audio-compositor', 'Reverb init failed, routing dry', e);
      this.reverbSend.connect(this.masterGain);
    }

    log.info('audio-compositor', 'Init complete (layers connected on start)');
  }

  /** Start all layers (call after init, on session start) */
  start(preset?: Partial<AudioPreset>): void {
    if (this.isPlaying) return;
    this.isPlaying = true;

    if (preset) {
      this.currentPreset = mergePreset(this.currentPreset, preset);
    }

    // Connect + apply preset + start all layers
    for (const layer of this.layers) {
      try {
        if (this.reverbSend && this.dryGain) {
          layer.connect(this.reverbSend, this.dryGain);
        }
        layer.applyPreset(this.currentPreset, 0);
        layer.start();
        log.info('audio-compositor', `Layer started: ${layer.name}`);
      } catch (e) {
        log.warn('audio-compositor', `Layer ${layer.name} failed to start`, e);
      }
    }

    // Fade in master
    this.masterGain?.gain.rampTo(this.currentPreset.master.volume, 3);

    log.info('audio-compositor', `Started, master volume target: ${this.currentPreset.master.volume}`);
  }

  /** Smoothly transition to a new preset (on stage change) */
  applyPreset(partial: Partial<AudioPreset>, rampTime = 3): void {
    this.currentPreset = mergePreset(this.currentPreset, partial);

    // Reverb
    if (this.reverbSend) this.reverbSend.gain.rampTo(this.currentPreset.reverb.wet, rampTime);
    if (this.dryGain) this.dryGain.gain.rampTo(1 - this.currentPreset.reverb.wet, rampTime);

    // Master volume
    if (this.masterGain) this.masterGain.gain.rampTo(this.currentPreset.master.volume, rampTime);

    // All layers
    for (const layer of this.layers) {
      layer.applyPreset(this.currentPreset, rampTime);
    }
  }

  private _duckLevel = 1;

  /** Update each frame — breath modulation, voice ducking */
  update(inputs: WorldInputs, dt: number): void {
    if (!this.isPlaying) return;

    // Voice ducking — lower ambient when narration is speaking
    const voiceActive = inputs.voiceEnergy > 0.05;
    const duckTarget = voiceActive ? 0.45 : 1;
    this._duckLevel += (duckTarget - this._duckLevel) * (voiceActive ? 0.08 : 0.03); // fast duck, slow release
    if (this.masterGain) {
      this.masterGain.gain.rampTo(this.currentPreset.master.volume * this._duckLevel, 0.1);
    }

    for (const layer of this.layers) {
      layer.update(inputs, dt);
    }
  }

  /** Set master volume (from settings) */
  setMasterVolume(v: number): void {
    if (this.masterGain) this.masterGain.gain.rampTo(v, 0.3);
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

    for (const layer of this.layers) {
      layer.stop(3);
    }

    if (this.masterGain) {
      this.masterGain.gain.rampTo(0, 3);
    }

    // Dispose after fade
    setTimeout(() => {
      for (const layer of this.layers) {
        layer.dispose();
      }
      this.reverb?.dispose();
      this.reverbSend?.dispose();
      this.dryGain?.dispose();
      this.compressor?.dispose();
      this.masterGain?.dispose();
      this.reverb = null;
      this.reverbSend = null;
      this.dryGain = null;
      this.compressor = null;
      this.masterGain = null;
    }, 5000);

    log.info('audio-compositor', 'Stopped');
  }

  dispose(): void {
    this.stop();
    this.layers = [];
  }
}
