/**
 * Generative ambient music layer — procedural, no audio files.
 * Creates evolving pad textures, slow melodies, and filtered noise.
 * Everything breathes with the BreathController.
 */

import type { BreathController } from './breath';

// Pentatonic scale intervals (semitones from root) — always consonant
const PENTATONIC = [0, 3, 5, 7, 10, 12, 15, 17, 19];

interface AmbientProfile {
  rootNote: number;      // MIDI note (e.g. 48 = C3)
  warmth: number;        // 0-1 filter warmth
  tempo: number;         // seconds between melody notes
  reverbDecay: number;   // reverb tail in seconds
  noiseLevel: number;    // 0-1 noise texture amount
  padLevel: number;      // 0-1 pad volume
  melodyLevel: number;   // 0-1 melody volume
}

const DEFAULT_PROFILE: AmbientProfile = {
  rootNote: 48,
  warmth: 0.7,
  tempo: 4,
  reverbDecay: 3,
  noiseLevel: 0.3,
  padLevel: 0.5,
  melodyLevel: 0.4,
};

export class AmbientEngine {
  private ctx: AudioContext | null = null;
  private output: GainNode | null = null;
  private masterGain: GainNode | null = null;

  // Layers
  private padOscs: OscillatorNode[] = [];
  private padGain: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;

  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;

  private melodyOsc: OscillatorNode | null = null;
  private melodyGain: GainNode | null = null;
  private melodyFilter: BiquadFilterNode | null = null;

  private convolver: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private dryGain: GainNode | null = null;

  private profile: AmbientProfile = { ...DEFAULT_PROFILE };
  private breath: BreathController | null = null;
  private isPlaying = false;
  private melodyTimer: number | null = null;
  private lastNoteIndex = 0;

  /**
   * Start the ambient engine.
   * @param ctx AudioContext from main AudioEngine
   * @param output GainNode to connect to (e.g. masterGain)
   * @param breath BreathController for sync
   */
  start(ctx: AudioContext, output: GainNode, breath: BreathController, profile?: Partial<AmbientProfile>): void {
    if (this.isPlaying) return;
    this.ctx = ctx;
    this.output = output;
    this.breath = breath;
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    this.isPlaying = true;

    const now = ctx.currentTime;

    // ── Reverb (convolution with generated impulse) ──
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.createReverbImpulse(ctx, this.profile.reverbDecay);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.6;
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0.4;

    // Master mix
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0;
    this.masterGain.gain.linearRampToValueAtTime(0.5, now + 10); // slow fade in

    // Reverb routing: source → convolver → reverbGain → master
    //                 source → dryGain → master
    this.convolver.connect(this.reverbGain);
    this.reverbGain.connect(this.masterGain);
    this.dryGain.connect(this.masterGain);
    this.masterGain.connect(output);

    // ── Pad layer — evolving chord ──
    this.createPadLayer(ctx, now);

    // ── Noise texture — filtered noise for atmosphere ──
    this.createNoiseLayer(ctx, now);

    // ── Melody — slow pentatonic notes ──
    this.createMelodyLayer(ctx, now);
    this.scheduleMelody();
  }

  /** Update each frame — modulate filters and volumes with breath */
  update(): void {
    if (!this.ctx || !this.breath || !this.isPlaying) return;

    const br = this.breath.value; // 0-1
    const now = this.ctx.currentTime;

    // Pad filter opens on inhale, closes on exhale
    if (this.padFilter) {
      const baseFreq = 200 + this.profile.warmth * 400;
      const breathFreq = baseFreq + br * 600;
      this.padFilter.frequency.setTargetAtTime(breathFreq, now, 0.1);
    }

    // Pad volume swells with breath
    if (this.padGain) {
      const vol = 0.06 + br * 0.06 * this.profile.padLevel;
      this.padGain.gain.setTargetAtTime(vol, now, 0.15);
    }

    // Noise filter — opens more on exhale (wind-like)
    if (this.noiseFilter) {
      const noiseFreq = 300 + (1 - br) * 400;
      this.noiseFilter.frequency.setTargetAtTime(noiseFreq, now, 0.2);
    }

    // Noise volume — slightly louder on exhale
    if (this.noiseGain) {
      const vol = 0.01 + (1 - br) * 0.02 * this.profile.noiseLevel;
      this.noiseGain.gain.setTargetAtTime(vol, now, 0.2);
    }
  }

  stop(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;

    if (this.melodyTimer) {
      clearTimeout(this.melodyTimer);
      this.melodyTimer = null;
    }

    const now = this.ctx?.currentTime ?? 0;

    // Fade out
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(0, now, 2);
    }

    // Stop oscillators after fade
    setTimeout(() => {
      for (const osc of this.padOscs) {
        try { osc.stop(); } catch {}
      }
      this.padOscs = [];
      try { this.noiseSource?.stop(); } catch {}
      try { this.melodyOsc?.stop(); } catch {}
      this.noiseSource = null;
      this.melodyOsc = null;
    }, 4000);
  }

  // ── Layer creation ──

  private createPadLayer(ctx: AudioContext, now: number): void {
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 400;
    this.padFilter.Q.value = 0.7;

    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.08 * this.profile.padLevel;

    // 3-note chord from pentatonic
    const root = this.midiToFreq(this.profile.rootNote);
    const intervals = [0, 7, 12]; // root, fifth, octave

    for (const interval of intervals) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = root * Math.pow(2, interval / 12);

      // Slight detune for warmth
      osc.detune.value = (Math.random() - 0.5) * 8;

      osc.connect(this.padFilter);
      osc.start(now);
      this.padOscs.push(osc);
    }

    // Add a second layer with triangle waves, one octave down
    const subOsc = ctx.createOscillator();
    subOsc.type = 'triangle';
    subOsc.frequency.value = root / 2;
    subOsc.connect(this.padFilter);
    subOsc.start(now);
    this.padOscs.push(subOsc);

    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.convolver!);
    this.padGain.connect(this.dryGain!);
  }

  private createNoiseLayer(ctx: AudioContext, now: number): void {
    // Generate filtered noise buffer
    const bufferSize = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.5;
    }

    this.noiseSource = ctx.createBufferSource();
    this.noiseSource.buffer = buffer;
    this.noiseSource.loop = true;

    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 400;
    this.noiseFilter.Q.value = 0.5;

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0.03 * this.profile.noiseLevel;

    this.noiseSource.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.convolver!);
    this.noiseGain.connect(this.dryGain!);

    this.noiseSource.start(now);
  }

  private createMelodyLayer(ctx: AudioContext, now: number): void {
    this.melodyOsc = ctx.createOscillator();
    this.melodyOsc.type = 'sine';
    this.melodyOsc.frequency.value = this.midiToFreq(this.profile.rootNote);

    this.melodyFilter = ctx.createBiquadFilter();
    this.melodyFilter.type = 'lowpass';
    this.melodyFilter.frequency.value = 800;
    this.melodyFilter.Q.value = 1;

    this.melodyGain = ctx.createGain();
    this.melodyGain.gain.value = 0;

    this.melodyOsc.connect(this.melodyFilter);
    this.melodyFilter.connect(this.melodyGain);
    this.melodyGain.connect(this.convolver!);
    this.melodyGain.connect(this.dryGain!);

    this.melodyOsc.start(now);
  }

  private scheduleMelody(): void {
    if (!this.isPlaying || !this.ctx) return;

    const playNote = () => {
      if (!this.isPlaying || !this.ctx || !this.melodyOsc || !this.melodyGain) return;

      // Pick next note — tendency to move by small intervals
      const step = Math.random() < 0.7
        ? (Math.random() < 0.5 ? -1 : 1) // step up or down
        : Math.floor(Math.random() * 3) - 1; // occasional leap

      this.lastNoteIndex = Math.max(0, Math.min(PENTATONIC.length - 1, this.lastNoteIndex + step));
      const semitone = PENTATONIC[this.lastNoteIndex];
      const freq = this.midiToFreq(this.profile.rootNote + semitone);

      const now = this.ctx.currentTime;

      // Glide to new note
      this.melodyOsc.frequency.setTargetAtTime(freq, now, 0.3);

      // Envelope: gentle attack, hold, gentle release
      const attack = 0.8;
      const hold = this.profile.tempo * 0.4;
      const release = this.profile.tempo * 0.4;
      const volume = 0.03 * this.profile.melodyLevel;

      this.melodyGain.gain.cancelScheduledValues(now);
      this.melodyGain.gain.setValueAtTime(this.melodyGain.gain.value, now);
      this.melodyGain.gain.linearRampToValueAtTime(volume, now + attack);
      this.melodyGain.gain.setValueAtTime(volume, now + attack + hold);
      this.melodyGain.gain.linearRampToValueAtTime(0, now + attack + hold + release);

      // Schedule next note
      const jitter = (Math.random() - 0.5) * this.profile.tempo * 0.3;
      const nextTime = (this.profile.tempo + jitter) * 1000;
      this.melodyTimer = window.setTimeout(playNote, nextTime);
    };

    // Start after a delay
    this.melodyTimer = window.setTimeout(playNote, this.profile.tempo * 1000);
  }

  // ── Utilities ──

  private createReverbImpulse(ctx: AudioContext, decay: number): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * decay;
    const buffer = ctx.createBuffer(2, length, sampleRate);

    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        // Exponential decay with noise
        data[i] = (Math.random() * 2 - 1) * Math.exp(-t / (decay * 0.4));
      }
    }

    return buffer;
  }

  private midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }
}
