/**
 * AudioCompositor — unified sound engine.
 *
 * Mirrors the visual compositor: layers + master bus + presets.
 * Replaces both AudioEngine (binaural/drone) and AmbientEngine (pad/noise/melody).
 *
 * Signal chain:
 *   layers → reverbSend → Tone.Convolver (real IR) → masterGain
 *   layers → dryGain → masterGain
 *   masterGain → duck filter → Tone.Compressor → output (analyzer → destination)
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
  private convolver: Tone.Convolver | null = null;
  private reverbSend: Tone.Gain | null = null;
  private dryGain: Tone.Gain | null = null;
  private masterGain: Tone.Gain | null = null;
  private compressor: Tone.Compressor | null = null;

  // Frequency-aware ducking: scoop voice-range mids instead of ducking everything
  private _duckFilter: BiquadFilterNode | null = null;

  // Convolution reverb IR URLs (real recorded spaces from EchoThief)
  static readonly IR_URLS = {
    chapel: 'audio/ir/chapel.wav',      // warm intimate (1.9s, default)
    cathedral: 'audio/ir/cathedral.wav', // spacious (2.9s, deep stages)
    dome: 'audio/ir/dome.wav',           // ethereal (3.0s, deepest stages)
  };
  private _currentIR: string = 'chapel';

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

    // Limiter → raw output (prevents clipping on all devices, especially mobile)
    // Fault-tolerant: if compressor fails, master gain connects directly to output
    let outputNode: Tone.ToneAudioNode | GainNode = output;
    try {
      this.compressor = new Tone.Compressor({
        threshold: -6,   // catch peaks above -6 dB
        ratio: 12,       // hard limiting
        attack: 0.003,   // fast attack to catch transients
        release: 0.1,    // quick release to avoid pumping
        knee: 3,
      });
      try {
        Tone.connect(this.compressor, output);
      } catch {
        (this.compressor as unknown as { output: AudioNode }).output.connect(output);
      }
      outputNode = this.compressor;
      log.info('audio-compositor', 'Limiter active');
    } catch (e) {
      log.warn('audio-compositor', 'Compressor creation failed, bypassing limiter', e);
      this.compressor = null;
    }

    // Voice-ducking EQ: peaking filter at 800Hz (voice fundamental range).
    // When voice is active, gain goes negative to scoop out voice frequencies
    // while leaving bass and highs untouched — keeps the bass bed warm during narration.
    try {
      const rawCtx2 = output.context as AudioContext;
      this._duckFilter = rawCtx2.createBiquadFilter();
      this._duckFilter.type = 'peaking';
      this._duckFilter.frequency.value = 800;
      this._duckFilter.Q.value = 0.5;  // wide band (covers ~200-4000Hz)
      this._duckFilter.gain.value = 0;  // no ducking by default
      if (outputNode instanceof GainNode) {
        this._duckFilter.connect(outputNode);
      } else {
        Tone.connect(this._duckFilter, outputNode);
      }
      outputNode = this._duckFilter as unknown as Tone.ToneAudioNode;
      log.info('audio-compositor', 'Voice-ducking EQ active');
    } catch (e) {
      log.warn('audio-compositor', 'Duck filter failed', e);
    }

    // Master gain → duck filter → limiter → output
    this.masterGain = new Tone.Gain(0);
    if (outputNode instanceof GainNode) {
      try { Tone.connect(this.masterGain, outputNode); } catch {
        (this.masterGain as unknown as { output: AudioNode }).output.connect(outputNode);
      }
    } else {
      this.masterGain.connect(outputNode);
    }
    log.info('audio-compositor', 'Master gain connected');

    // Dry path — higher initial gain for audibility
    this.dryGain = new Tone.Gain(0.6);
    this.dryGain.connect(this.masterGain);

    // Reverb send — start routed to dry (instant), connect convolver async
    this.reverbSend = new Tone.Gain(0.4);
    this.reverbSend.connect(this.masterGain); // pass-through until IR loads

    // Load real convolution reverb IR (recorded space) — non-blocking
    this._loadConvolver('chapel');

    log.info('audio-compositor', 'Init complete (convolver loading async)');
  }

  /** Load a convolution reverb IR by name, rerouting the reverb send */
  private async _loadConvolver(name: keyof typeof AudioCompositor.IR_URLS): Promise<void> {
    if (this._currentIR === name && this.convolver) return;
    const url = AudioCompositor.IR_URLS[name];
    if (!url) return;

    try {
      const newConvolver = new Tone.Convolver(url);

      // Wait for IR to load
      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          try {
            if ((newConvolver as unknown as { _buffer: unknown })._buffer ||
                (newConvolver.buffer && newConvolver.buffer.length > 0)) {
              clearInterval(check);
              resolve();
            }
          } catch { /* buffer not ready yet */ }
        }, 100);
        setTimeout(() => { clearInterval(check); reject(new Error('IR load timeout')); }, 10000);
      });

      // Disconnect old convolver
      if (this.convolver && this.reverbSend) {
        try { this.reverbSend.disconnect(this.convolver); } catch { /* ok */ }
        this.convolver.dispose();
      }

      // Reroute: reverbSend → convolver → masterGain
      if (this.reverbSend && this.masterGain) {
        try { this.reverbSend.disconnect(); } catch { /* ok */ }
        this.reverbSend.connect(newConvolver);
        newConvolver.connect(this.masterGain);
      }

      this.convolver = newConvolver;
      this._currentIR = name;
      log.info('audio-compositor', `Convolver loaded: ${name} (${url})`);
    } catch (e) {
      log.warn('audio-compositor', `Convolver load failed: ${name}`, e);
      // Fallback: reverbSend stays connected to masterGain (dry pass-through)
      if (this.reverbSend && this.masterGain) {
        try { this.reverbSend.connect(this.masterGain); } catch { /* ok */ }
      }
    }
  }

  /** Pick the best IR for the current reverb decay setting */
  private _pickIR(decay: number): keyof typeof AudioCompositor.IR_URLS {
    if (decay >= 5) return 'dome';       // ethereal, long tail
    if (decay >= 4) return 'cathedral';  // spacious
    return 'chapel';                     // warm, intimate (default)
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

    // Reverb wet/dry mix
    if (this.reverbSend) this.reverbSend.gain.rampTo(this.currentPreset.reverb.wet, rampTime);
    if (this.dryGain) this.dryGain.gain.rampTo(1 - this.currentPreset.reverb.wet, rampTime);

    // Switch IR if reverb character changed (chapel → cathedral → dome by depth)
    const targetIR = this._pickIR(this.currentPreset.reverb.decay);
    if (targetIR !== this._currentIR) {
      this._loadConvolver(targetIR);
    }

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

  /** Update each frame — breath modulation, frequency-aware voice ducking */
  update(inputs: WorldInputs, dt: number): void {
    if (!this.isPlaying) return;

    // Frequency-aware voice ducking:
    // Gentle overall volume reduction + mid-frequency scoop during narration.
    // Bass and highs stay full → warm, immersive sound while voice plays.
    const voiceActive = inputs.voiceEnergy > 0.05;
    const duckTarget = voiceActive ? 0.55 : 1;  // less overall duck (was 0.45)
    this._duckLevel += (duckTarget - this._duckLevel) * (voiceActive ? 0.08 : 0.03);

    if (this.masterGain) {
      this.masterGain.gain.rampTo(this._userVolume * this._duckLevel, 0.15);
    }

    // Frequency-selective ducking: pull down voice-range mids
    if (this._duckFilter) {
      const duckGainDb = voiceActive ? -6 : 0;
      const currentGain = this._duckFilter.gain.value;
      const targetGain = currentGain + (duckGainDb - currentGain) * (voiceActive ? 0.06 : 0.02);
      this._duckFilter.gain.value = targetGain;
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
      convolver: this.convolver, reverbSend: this.reverbSend,
      dryGain: this.dryGain, compressor: this.compressor,
      masterGain: this.masterGain, duckFilter: this._duckFilter,
    };
    this.convolver = null;
    this.reverbSend = null;
    this.dryGain = null;
    this.compressor = null;
    this.masterGain = null;
    this._duckFilter = null;

    this._stopTimer = setTimeout(() => {
      this._stopTimer = null;
      for (const layer of layersToDispose) {
        try { layer.dispose(); } catch { /* ok */ }
      }
      busNodes.convolver?.dispose();
      busNodes.reverbSend?.dispose();
      busNodes.dryGain?.dispose();
      busNodes.compressor?.dispose();
      busNodes.masterGain?.dispose();
      try { busNodes.duckFilter?.disconnect(); } catch { /* ok */ }
    }, 5000);

    log.info('audio-compositor', 'Stopped');
  }

  dispose(): void {
    this.stop();
    this.layers = [];
  }
}
