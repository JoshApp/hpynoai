/**
 * Audio engine — binaural beats + ambient drone layers
 * Now configurable via AudioProfile from session configs.
 */

import type { AudioProfile } from './session';
import { AudioAnalyzer, type AudioBands } from './audio-analyzer';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private binauralLeft: OscillatorNode | null = null;
  private binauralRight: OscillatorNode | null = null;
  private droneOsc1: OscillatorNode | null = null;
  private droneOsc2: OscillatorNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private isPlaying = false;
  private isMuted = false;
  private preMuteGain = 1;
  private binauralEnabled = true;
  private binauralGainNode: GainNode | null = null;
  private profile: AudioProfile | null = null;
  private _analyzer: AudioAnalyzer | null = null;

  /** Background ambient track */
  private bgTrackSource: AudioBufferSourceNode | null = null;
  private bgTrackGain: GainNode | null = null;

  /** External audio input node — connect TTS or other audio sources here */
  private externalInput: GainNode | null = null;

  get analyzer(): AudioAnalyzer | null {
    return this._analyzer;
  }

  /** Get the AudioContext (for connecting external audio sources) */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Get the external input node — connect narration audio here so it flows through the analyzer */
  get externalInputNode(): GainNode | null {
    return this.externalInput;
  }

  /** Get the master gain node — connect ambient music here so it respects volume/mute */
  get masterGainNode(): GainNode | null {
    return this.masterGain;
  }

  async init(): Promise<void> {
    this.ctx = new AudioContext();

    // Create analyzer — sits between masterGain and destination
    this._analyzer = new AudioAnalyzer(this.ctx, 1024);

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0;

    // External input for narration/TTS audio
    this.externalInput = this.ctx.createGain();
    this.externalInput.gain.value = 1;

    // Audio graph: [sources] → masterGain → analyser → destination
    //              [external] → analyser → destination
    this.masterGain.connect(this._analyzer.node);
    this.externalInput.connect(this._analyzer.node);
    this._analyzer.node.connect(this.ctx.destination);
  }

  start(profile?: AudioProfile): void {
    if (!this.ctx || !this.masterGain || this.isPlaying) return;
    this.isPlaying = true;
    if (profile) this.profile = profile;

    const p = this.profile ?? {
      binauralRange: [4, 2] as [number, number],
      carrierFreq: 100,
      droneFreq: 55,
      droneFifth: 82.5,
      lfoSpeed: 0.08,
      filterCutoff: 300,
      warmth: 0.7,
    };

    const now = this.ctx.currentTime;

    // ── Binaural beat ──
    const merger = this.ctx.createChannelMerger(2);
    this.binauralGainNode = this.ctx.createGain();
    this.binauralGainNode.gain.value = this.binauralEnabled ? 0.12 : 0;

    this.binauralLeft = this.ctx.createOscillator();
    this.binauralLeft.type = 'sine';
    this.binauralLeft.frequency.value = p.carrierFreq;

    this.binauralRight = this.ctx.createOscillator();
    this.binauralRight.type = 'sine';
    this.binauralRight.frequency.value = p.carrierFreq + p.binauralRange[0];

    this.binauralLeft.connect(merger, 0, 0);
    this.binauralRight.connect(merger, 0, 1);
    merger.connect(this.binauralGainNode);
    this.binauralGainNode.connect(this.masterGain);

    this.binauralLeft.start(now);
    this.binauralRight.start(now);

    // ── Ambient drone layer ──
    const droneGain = this.ctx.createGain();
    droneGain.gain.value = 0.06;

    this.droneOsc1 = this.ctx.createOscillator();
    this.droneOsc1.type = 'sine';
    this.droneOsc1.frequency.value = p.droneFreq;

    this.droneOsc2 = this.ctx.createOscillator();
    this.droneOsc2.type = 'triangle';
    this.droneOsc2.frequency.value = p.droneFifth;

    // LFO for subtle movement
    this.lfo = this.ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = p.lfoSpeed;
    this.lfoGain = this.ctx.createGain();
    this.lfoGain.gain.value = 3;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.droneOsc2.frequency);
    this.lfo.start(now);

    // Filter — cutoff and Q from profile warmth
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.filterCutoff;
    filter.Q.value = 1 + p.warmth * 3;

    this.droneOsc1.connect(filter);
    this.droneOsc2.connect(filter);
    filter.connect(droneGain);
    droneGain.connect(this.masterGain);

    this.droneOsc1.start(now);
    this.droneOsc2.start(now);

    // Fade in master (respect mute state)
    this.masterGain.gain.setValueAtTime(0, now);
    if (!this.isMuted) {
      this.masterGain.gain.linearRampToValueAtTime(this.preMuteGain, now + 8);
    }

    // ── Background ambient track (if configured) ──
    if (p.backgroundTrack) {
      this.loadBackgroundTrack(p.backgroundTrack, p.backgroundVolume ?? 0.3);
    }
  }

  /** Load and loop a background audio file */
  private async loadBackgroundTrack(url: string, volume: number): Promise<void> {
    if (!this.ctx || !this.masterGain) return;

    try {
      const response = await fetch(url);
      if (!response.ok) return;
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

      // Stop any existing background track
      this.stopBackgroundTrack();

      this.bgTrackGain = this.ctx.createGain();
      this.bgTrackGain.gain.value = 0;
      this.bgTrackGain.connect(this.masterGain);

      this.bgTrackSource = this.ctx.createBufferSource();
      this.bgTrackSource.buffer = audioBuffer;
      this.bgTrackSource.loop = true;

      // Crossfade loop: set loop points slightly inward to avoid clicks
      const margin = Math.min(0.5, audioBuffer.duration * 0.02);
      this.bgTrackSource.loopStart = margin;
      this.bgTrackSource.loopEnd = audioBuffer.duration - margin;

      this.bgTrackSource.connect(this.bgTrackGain);
      this.bgTrackSource.start();

      // Fade in over 6 seconds
      const now = this.ctx.currentTime;
      this.bgTrackGain.gain.setValueAtTime(0, now);
      this.bgTrackGain.gain.linearRampToValueAtTime(volume, now + 6);
    } catch {
      // Failed to load — continue without background track
    }
  }

  private stopBackgroundTrack(): void {
    try { this.bgTrackSource?.stop(); } catch {}
    this.bgTrackSource = null;
    this.bgTrackGain = null;
  }

  /** Set intensity 0–1, interpolates binaural beat across profile range */
  setIntensity(intensity: number): void {
    if (!this.ctx || !this.binauralRight || !this.profile) return;
    const [startHz, endHz] = this.profile.binauralRange;
    const beatFreq = startHz + (endHz - startHz) * intensity;
    this.binauralRight.frequency.setTargetAtTime(
      this.profile.carrierFreq + beatFreq,
      this.ctx.currentTime,
      2,
    );
  }

  fadeOut(duration = 4): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.linearRampToValueAtTime(0, now + duration);

    setTimeout(() => {
      this.stop();
    }, duration * 1000 + 100);
  }

  private stop(): void {
    this.binauralLeft?.stop();
    this.binauralRight?.stop();
    this.droneOsc1?.stop();
    this.droneOsc2?.stop();
    this.lfo?.stop();
    this.stopBackgroundTrack();
    this.binauralLeft = null;
    this.binauralRight = null;
    this.droneOsc1 = null;
    this.droneOsc2 = null;
    this.lfo = null;
    this.isPlaying = false;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (!this.masterGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    // Cancel any scheduled ramps (e.g. the 8s fade-in) so they don't override us
    this.masterGain.gain.cancelScheduledValues(now);
    if (muted) {
      this.preMuteGain = Math.max(this.preMuteGain, this.masterGain.gain.value);
      this.masterGain.gain.setValueAtTime(0, now);
    } else {
      this.masterGain.gain.setValueAtTime(this.preMuteGain, now);
    }
  }

  setMasterVolume(volume: number): void {
    this.preMuteGain = volume;
    if (!this.masterGain || !this.ctx || this.isMuted) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(volume, now, 0.1);
  }

  setBinauralEnabled(enabled: boolean): void {
    this.binauralEnabled = enabled;
    if (!this.binauralGainNode || !this.ctx) return;
    this.binauralGainNode.gain.setTargetAtTime(
      enabled ? 0.12 : 0,
      this.ctx.currentTime,
      0.5,
    );
  }

  /** Restart with a new audio profile (for session switching) */
  async restart(profile: AudioProfile): Promise<void> {
    if (this.isPlaying) {
      this.stop();
    }
    if (!this.ctx) {
      await this.init();
    }
    this.start(profile);
  }

  dispose(): void {
    this.fadeOut(1);
    setTimeout(() => this.ctx?.close(), 2000);
  }
}
