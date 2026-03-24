/**
 * Generative ambient music layer — powered by Tone.js.
 *
 * Three layers:
 *   PAD   — FM synth chord, breath-modulated filter, chorus + reverb
 *   NOISE — pink/brown noise, breath-modulated filter for wind texture
 *   MELODY — FM synth playing slow pentatonic notes with long reverb
 *
 * Everything evolves per-stage: deeper stages = less melody, warmer filter,
 * more noise, simpler harmonics.
 */

import * as Tone from 'tone';
import type { BreathController } from './breath';
import type { EventBus } from './events';
import type { AudioEngine } from './audio';
import { log } from './logger';

// Pentatonic scale intervals — always consonant
const PENTATONIC = [0, 3, 5, 7, 10, 12, 15, 17, 19];

export interface AmbientProfile {
  rootNote: number;        // MIDI note (48 = C3)
  warmth: number;          // 0-1 filter resonance
  tempo: number;           // seconds between melody notes (0 = no melody)
  reverbDecay: number;     // reverb tail in seconds
  noiseLevel: number;      // 0-1 noise texture amount
  padLevel: number;        // 0-1 pad volume
  melodyLevel: number;     // 0-1 melody volume
  filterMax: number;       // max filter freq on inhale (Hz)
  padType: OscillatorType; // oscillator waveform (ignored now — FM synth)
}

const DEFAULT_PROFILE: AmbientProfile = {
  rootNote: 48,
  warmth: 0.7,
  tempo: 4,
  reverbDecay: 3,
  noiseLevel: 0.3,
  padLevel: 0.5,
  melodyLevel: 0.4,
  filterMax: 1200,
  padType: 'sawtooth',
};

function midiToNote(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[midi % 12]}${octave}`;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class AmbientEngine {
  private profile: AmbientProfile = { ...DEFAULT_PROFILE };
  private breath: BreathController | null = null;
  private isPlaying = false;

  // Tone.js nodes
  private padSynth: Tone.PolySynth | null = null;
  private padFilter: Tone.Filter | null = null;
  private padChorus: Tone.Chorus | null = null;
  private padGain: Tone.Gain | null = null;

  private noiseSrc: Tone.Noise | null = null;
  private noiseFilter: Tone.Filter | null = null;
  private noiseGain: Tone.Gain | null = null;

  private melodySynth: Tone.FMSynth | null = null;
  private melodyGain: Tone.Gain | null = null;

  private reverb: Tone.Reverb | null = null;
  private masterGain: Tone.Gain | null = null;

  private melodyTimer: number | null = null;
  private lastNoteIndex = 0;
  private _volumeScale = 0.4;

  start(
    _ctx: AudioContext,
    output: GainNode,
    breath: BreathController,
    profile?: Partial<AmbientProfile>,
  ): void {
    if (this.isPlaying) return;
    this.breath = breath;
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    this.isPlaying = true;

    // Connect Tone.js output to our existing Web Audio graph
    this.masterGain = new Tone.Gain(0);
    this.masterGain.connect(output);
    // Fade in
    this.masterGain.gain.rampTo(this._volumeScale, 3);

    // ── Reverb ──
    this.reverb = new Tone.Reverb({
      decay: this.profile.reverbDecay,
      wet: 0.7,
      preDelay: 0.1,
    });
    this.reverb.connect(this.masterGain);
    // Also dry path
    const dryGain = new Tone.Gain(0.3);
    dryGain.connect(this.masterGain);

    // ── Pad layer: FM synth chord ──
    this.padFilter = new Tone.Filter({
      frequency: 600,
      type: 'lowpass',
      Q: 1 + this.profile.warmth * 2,
      rolloff: -24,
    });

    this.padChorus = new Tone.Chorus({
      frequency: 0.3,
      delayTime: 3.5,
      depth: 0.6,
      wet: 0.4,
    }).start();

    this.padGain = new Tone.Gain(0.15 * this.profile.padLevel);

    this.padSynth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 2,
      modulationIndex: 3,
      oscillator: { type: 'sine' },
      modulation: { type: 'triangle' },
      envelope: { attack: 3, decay: 1, sustain: 0.9, release: 5 },
      modulationEnvelope: { attack: 2, decay: 0.5, sustain: 0.8, release: 4 },
    });
    this.padSynth.volume.value = -6;

    // Chain: synth → filter → chorus → gain → reverb + dry
    this.padSynth.connect(this.padFilter);
    this.padFilter.connect(this.padChorus);
    this.padChorus.connect(this.padGain);
    this.padGain.connect(this.reverb);
    this.padGain.connect(dryGain);

    // Play initial chord
    const root = this.profile.rootNote;
    const chord = [root, root + 4, root + 7, root + 12].map(midiToNote);
    this.padSynth.triggerAttack(chord);

    // ── Noise layer: pink noise for warmth ──
    this.noiseFilter = new Tone.Filter({
      frequency: 400,
      type: 'bandpass',
      Q: 0.5,
    });

    this.noiseGain = new Tone.Gain(0.04 * this.profile.noiseLevel);

    this.noiseSrc = new Tone.Noise('pink');
    this.noiseSrc.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.reverb);
    this.noiseGain.connect(dryGain);
    this.noiseSrc.start();

    // ── Melody layer: FM synth with long release ──
    this.melodyGain = new Tone.Gain(0.08 * this.profile.melodyLevel);

    this.melodySynth = new Tone.FMSynth({
      harmonicity: 5,
      modulationIndex: 8,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 1.5, decay: 0.5, sustain: 0.6, release: 3 },
      modulationEnvelope: { attack: 1, decay: 0.2, sustain: 0.5, release: 2 },
    });
    this.melodySynth.volume.value = -10;

    this.melodySynth.connect(this.melodyGain);
    this.melodyGain.connect(this.reverb);

    this.scheduleMelody();

    log.info('ambient', `Started: root=${midiToNote(root)} warmth=${this.profile.warmth} filterMax=${this.profile.filterMax}`);
  }

  /** Smoothly transition to a new ambient profile (on stage change) */
  setStageProfile(p: Partial<AmbientProfile>): void {
    if (!this.isPlaying) return;
    this.profile = { ...this.profile, ...p };

    const rampTime = 3; // seconds

    // Pad chord glide
    if (p.rootNote !== undefined && this.padSynth) {
      this.padSynth.releaseAll();
      const chord = [p.rootNote, p.rootNote + 4, p.rootNote + 7, p.rootNote + 12].map(midiToNote);
      this.padSynth.triggerAttack(chord);
    }

    // Filter warmth
    if (p.warmth !== undefined && this.padFilter) {
      this.padFilter.Q.rampTo(1 + p.warmth * 2, rampTime);
    }

    // Pad level
    if (p.padLevel !== undefined && this.padGain) {
      this.padGain.gain.rampTo(0.15 * p.padLevel, rampTime);
    }

    // Noise level
    if (p.noiseLevel !== undefined && this.noiseGain) {
      this.noiseGain.gain.rampTo(0.04 * p.noiseLevel, rampTime);
    }

    // Melody level (0 = silent)
    if (p.melodyLevel !== undefined && this.melodyGain) {
      this.melodyGain.gain.rampTo(0.08 * p.melodyLevel, rampTime);
    }

    log.info('ambient', `Stage: filterMax=${p.filterMax ?? '—'} melody=${p.melodyLevel ?? '—'} noise=${p.noiseLevel ?? '—'}`);
  }

  /** Update each frame — subtle breath modulation of filter */
  update(): void {
    if (!this.isPlaying || !this.breath) return;
    const br = this.breath.value; // 0-1

    // Pad filter — subtle breath sweep
    if (this.padFilter) {
      const baseFreq = 200 + this.profile.warmth * 300;
      const breathFreq = baseFreq + br * this.profile.filterMax * 0.25;
      this.padFilter.frequency.rampTo(breathFreq, 0.3);
    }

    // Noise filter — subtle inverse breath
    if (this.noiseFilter) {
      const noiseFreq = 300 + (1 - br) * this.profile.filterMax * 0.15;
      this.noiseFilter.frequency.rampTo(noiseFreq, 0.3);
    }
  }

  stop(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;

    if (this.melodyTimer) {
      clearTimeout(this.melodyTimer);
      this.melodyTimer = null;
    }

    // Fade out then dispose
    if (this.masterGain) {
      this.masterGain.gain.rampTo(0, 3);
    }

    setTimeout(() => {
      this.padSynth?.releaseAll();
      this.noiseSrc?.stop();
      this.padSynth?.dispose();
      this.padFilter?.dispose();
      this.padChorus?.dispose();
      this.padGain?.dispose();
      this.noiseSrc?.dispose();
      this.noiseFilter?.dispose();
      this.noiseGain?.dispose();
      this.melodySynth?.dispose();
      this.melodyGain?.dispose();
      this.reverb?.dispose();
      this.masterGain?.dispose();
      this.padSynth = null;
      this.padFilter = null;
      this.padChorus = null;
      this.padGain = null;
      this.noiseSrc = null;
      this.noiseFilter = null;
      this.noiseGain = null;
      this.melodySynth = null;
      this.melodyGain = null;
      this.reverb = null;
      this.masterGain = null;
    }, 4000);
  }

  setVolume(v: number): void {
    this._volumeScale = v;
    if (this.masterGain) {
      this.masterGain.gain.rampTo(v, 0.3);
    }
  }

  // ── Melody scheduling ──

  private scheduleMelody(): void {
    if (!this.isPlaying || this.profile.tempo <= 0) return;

    const playNote = () => {
      if (!this.isPlaying || !this.melodySynth) return;

      // Random walk on pentatonic scale
      const step = Math.random() < 0.7
        ? (Math.random() < 0.5 ? -1 : 1)
        : Math.floor(Math.random() * 3) - 1;

      this.lastNoteIndex = Math.max(0, Math.min(PENTATONIC.length - 1, this.lastNoteIndex + step));
      const semitone = PENTATONIC[this.lastNoteIndex];
      const note = midiToNote(this.profile.rootNote + semitone);
      const duration = this.profile.tempo * 0.7;

      if (this.profile.melodyLevel > 0) {
        this.melodySynth.triggerAttackRelease(note, duration);
      }

      // Schedule next
      const jitter = (Math.random() - 0.5) * this.profile.tempo * 0.3;
      this.melodyTimer = window.setTimeout(playNote, (this.profile.tempo + jitter) * 1000);
    };

    this.melodyTimer = window.setTimeout(playNote, this.profile.tempo * 1000);
  }

  // ── Bus-driven lifecycle ──
  private busUnsubs: Array<() => void> = [];

  connectBus(bus: EventBus, audioEngine: AudioEngine, breath: BreathController): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];

    this.busUnsubs.push(bus.on('settings:changed', ({ settings: s }) => {
      this.setVolume(s.ambientVolume);
    }));

    this.busUnsubs.push(bus.on('session:started', ({ session }) => {
      const ctx = audioEngine.context;
      const gain = audioEngine.masterGainNode;
      if (!ctx || !gain) return;

      const rootNotes: Record<string, number> = {
        relax: 48, sleep: 45, focus: 52, surrender: 50,
      };
      this.start(ctx, gain, breath, {
        rootNote: rootNotes[session.id] ?? 48,
        warmth: session.audio.warmth,
        tempo: 5,
        reverbDecay: 4,
      });
    }));

    this.busUnsubs.push(bus.on('session:ended', () => {
      this.stop();
    }));
  }

  dispose(): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
    this.stop();
  }
}
