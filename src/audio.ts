/**
 * Audio engine — manages AudioContext, master gain, and analyzer.
 *
 * Synthesis (binaural, drone, pad, noise, melody) is now handled by
 * the AudioCompositor. This class just provides the audio graph
 * infrastructure that everything connects to.
 */

import type { AudioProfile } from './session';
import { AudioAnalyzer, type AudioBands } from './audio-analyzer';
import type { EventBus } from './events';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private isMuted = false;
  private preMuteGain = 1;
  private _analyzer: AudioAnalyzer | null = null;

  /** External audio input node — connect TTS or other audio sources here */
  private externalInput: GainNode | null = null;

  get analyzer(): AudioAnalyzer | null { return this._analyzer; }
  get context(): AudioContext | null { return this.ctx; }
  get externalInputNode(): GainNode | null { return this.externalInput; }
  get masterGainNode(): GainNode | null { return this.masterGain; }

  async init(): Promise<void> {
    if (this.ctx) return; // already initialized

    this.ctx = new AudioContext();

    // iOS/Safari suspends AudioContext until a user gesture
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }

    // Analyzer sits between masterGain and destination
    this._analyzer = new AudioAnalyzer(this.ctx, 1024);

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;

    // External input for narration/TTS audio
    this.externalInput = this.ctx.createGain();
    this.externalInput.gain.value = 1;

    // Audio graph: [sources] → masterGain → analyser → destination
    //              [external] → analyser → destination
    this.masterGain.connect(this._analyzer.node);
    this.externalInput.connect(this._analyzer.node);
    this._analyzer.node.connect(this.ctx.destination);
  }

  /** Set intensity — no-op now, binaural handled by AudioCompositor */
  setIntensity(_intensity: number): void {}

  setMasterVolume(volume: number): void {
    if (!this.masterGain || !this.ctx) return;
    this.preMuteGain = volume;
    if (!this.isMuted) {
      this.masterGain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1);
    }
  }

  setMuted(muted: boolean): void {
    if (!this.masterGain || !this.ctx) return;
    this.isMuted = muted;
    this.masterGain.gain.setTargetAtTime(
      muted ? 0 : this.preMuteGain,
      this.ctx.currentTime,
      0.05,
    );
  }

  /** Fade out over N seconds (session ending) */
  fadeOut(seconds = 2): void {
    if (!this.masterGain || !this.ctx) return;
    this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, seconds * 0.3);
  }

  /** No-op — binaural handled by AudioCompositor */
  setBinauralEnabled(_enabled: boolean): void {}
  setBinauralVolume(_volume: number): void {}

  // ── Bus-driven lifecycle ──
  private busUnsubs: Array<() => void> = [];

  connectBus(bus: EventBus): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];

    this.busUnsubs.push(bus.on('session:ending', ({ fadeSec }) => {
      this.fadeOut(fadeSec ?? 2);
    }));

    this.busUnsubs.push(bus.on('settings:changed', ({ settings: s }) => {
      this.setMuted(s.muted);
      this.setMasterVolume(s.masterVolume);
    }));
  }

  dispose(): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
  }
}
