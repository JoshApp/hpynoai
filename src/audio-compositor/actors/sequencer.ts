/**
 * SequencerActor — chord progressions + phrase-based melody.
 *
 * Replaces MelodyActor. Instead of random note walks, plays:
 * 1. Chord progressions — cycles through curated chords, changes pad voicing
 * 2. Melody phrases — short motifs transposed to the current chord
 * 3. Texture events — occasional shimmers/swells for life
 *
 * All decisions use seeded RNG → same seed = same music = reproducible.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import { midiToNote } from '../types';
import { createRNG } from '../rng';
import type { WorldInputs } from '../../compositor/types';

// ── Musical data ─────────────────────────────────────────────

/** Chord defined as intervals from root (semitones) */
interface ChordShape {
  name: string;
  intervals: number[];   // e.g. [0, 4, 7, 12] = major + octave
  color: 'bright' | 'warm' | 'dark' | 'tension';
}

const CHORDS: Record<string, ChordShape> = {
  maj7:   { name: 'maj7',   intervals: [0, 4, 7, 11],     color: 'bright' },
  min7:   { name: 'min7',   intervals: [0, 3, 7, 10],     color: 'warm' },
  sus2:   { name: 'sus2',   intervals: [0, 2, 7, 12],     color: 'bright' },
  sus4:   { name: 'sus4',   intervals: [0, 5, 7, 12],     color: 'tension' },
  min9:   { name: 'min9',   intervals: [0, 3, 7, 14],     color: 'dark' },
  add9:   { name: 'add9',   intervals: [0, 4, 7, 14],     color: 'bright' },
  '5th':  { name: '5th',    intervals: [0, 7, 12, 19],    color: 'dark' },
  dim:    { name: 'dim',    intervals: [0, 3, 6, 12],     color: 'tension' },
};

/** Chord progressions per mood */
const PROGRESSIONS: Record<string, string[][]> = {
  // Each progression is an array of [chordName, rootOffset] pairs
  bright: [
    ['maj7', '0', 'add9', '5', 'sus2', '7', 'maj7', '0'],   // I → IV → V → I
    ['maj7', '0', 'min7', '9', 'sus2', '5', 'add9', '0'],   // I → vi → IV → I
  ],
  warm: [
    ['min7', '0', 'sus4', '5', 'min7', '3', 'sus2', '7'],   // i → iv → iii → v
    ['min7', '0', 'maj7', '3', 'min7', '7', 'sus4', '5'],   // i → III → v → iv
  ],
  dark: [
    ['min9', '0', '5th', '7', 'min9', '5', '5th', '0'],     // minimal movement
    ['min9', '0', 'min7', '3', '5th', '5', 'min9', '0'],    // slowly descending
  ],
};

/** Melody phrase templates (intervals from chord root) */
const PHRASES = [
  // Ascending gentle
  [0, 4, 7, 12, 7, 4],
  // Descending gentle
  [12, 7, 4, 0, 4, 7],
  // Arc up and down
  [0, 3, 7, 12, 10, 7, 3],
  // Sparse high
  [12, 0, 7, 0, 12],
  // Call and response
  [0, 4, 7, -1, 12, 7, 4],   // -1 = rest
  // Minimal
  [0, 7, 0, 12],
  // Breath-like (up on inhale feel, down on exhale)
  [0, 3, 7, 10, 12, 10, 7, 3, 0],
];

// ── Sequencer ────────────────────────────────────────────────

export class SequencerActor implements AudioLayer {
  name = 'melody';  // same name so it replaces MelodyActor in the system

  private melodySynth: Tone.FMSynth;
  private shimmerSynth: Tone.FMSynth;
  private gain: Tone.Gain;
  private shimmerGain: Tone.Gain;

  private rng: () => number;
  private isActive = false;
  private melodyTimer: number | null = null;
  private chordTimer: number | null = null;
  private shimmerTimer: number | null = null;

  // Musical state
  private rootNote = 48;
  private tempo = 5;
  private volume = 0.3;
  private mood: 'bright' | 'warm' | 'dark' = 'warm';
  private currentProgression: string[] = [];
  private chordIndex = 0;
  private currentChordRoot = 0;      // semitone offset from rootNote
  private currentChordShape: ChordShape = CHORDS.min7;
  private phraseIndex = 0;
  private noteInPhrase = 0;
  private currentPhrase: number[] = [];
  private chordDuration = 20;        // seconds per chord

  // Callback to change pad chord (set by compositor)
  private _onChordChange: ((chord: number[]) => void) | null = null;

  constructor(seed: number) {
    this.rng = createRNG(seed);

    // Melody — bell-like FM
    this.melodySynth = new Tone.FMSynth({
      harmonicity: 5,
      modulationIndex: 6,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 1.2, decay: 0.5, sustain: 0.5, release: 4 },
      modulationEnvelope: { attack: 0.8, decay: 0.2, sustain: 0.4, release: 3 },
    });
    this.melodySynth.volume.value = -8;

    // Shimmer — high, quiet, sparkly
    this.shimmerSynth = new Tone.FMSynth({
      harmonicity: 8,
      modulationIndex: 12,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.3, decay: 0.2, sustain: 0.3, release: 5 },
      modulationEnvelope: { attack: 0.2, decay: 0.1, sustain: 0.2, release: 3 },
    });
    this.shimmerSynth.volume.value = -14;

    this.gain = new Tone.Gain(0);
    this.shimmerGain = new Tone.Gain(0);
    this.melodySynth.connect(this.gain);
    this.shimmerSynth.connect(this.shimmerGain);
  }

  /** Set callback for when chord changes (compositor wires this to pad) */
  onChordChange(fn: (chord: number[]) => void): void {
    this._onChordChange = fn;
  }

  connect(wet: Tone.ToneAudioNode, _dry: Tone.ToneAudioNode): void {
    this.gain.connect(wet);
    this.shimmerGain.connect(wet);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.rootNote = p.melody.rootNote;
    this.tempo = p.melody.tempo;
    this.volume = p.melody.volume;
    this.gain.gain.rampTo(p.melody.volume, t);
    this.shimmerGain.gain.rampTo(p.melody.volume * 0.4, t);

    // Determine mood from pad warmth + noise level
    const warmth = p.pad?.warmth ?? 0.7;
    if (warmth > 0.8) this.mood = 'dark';
    else if (warmth > 0.5) this.mood = 'warm';
    else this.mood = 'bright';

    // Pick a progression for this mood
    const progs = PROGRESSIONS[this.mood] ?? PROGRESSIONS.warm;
    const progIdx = Math.floor(this.rng() * progs.length);
    this.currentProgression = progs[progIdx];
    this.chordIndex = 0;

    // Chord duration scales with tempo
    this.chordDuration = Math.max(10, this.tempo * 4);
  }

  update(_inputs: WorldInputs, _dt: number): void {}

  start(): void {
    this.isActive = true;
    this.advanceChord();
    this.schedulePhrase();
    this.scheduleShimmer();
  }

  stop(rampTime = 3): void {
    this.isActive = false;
    this.gain.gain.rampTo(0, rampTime);
    this.shimmerGain.gain.rampTo(0, rampTime);
    if (this.melodyTimer) { clearTimeout(this.melodyTimer); this.melodyTimer = null; }
    if (this.chordTimer) { clearTimeout(this.chordTimer); this.chordTimer = null; }
    if (this.shimmerTimer) { clearTimeout(this.shimmerTimer); this.shimmerTimer = null; }
  }

  dispose(): void {
    this.stop();
    this.melodySynth.dispose();
    this.shimmerSynth.dispose();
    this.gain.dispose();
    this.shimmerGain.dispose();
  }

  // ── Chord progression ──

  private advanceChord(): void {
    if (!this.isActive || this.currentProgression.length === 0) return;

    // Parse chord: [name, rootOffset, name, rootOffset, ...]
    const nameIdx = (this.chordIndex * 2) % this.currentProgression.length;
    const offsetIdx = nameIdx + 1;
    const chordName = this.currentProgression[nameIdx] ?? 'min7';
    const rootOffset = parseInt(this.currentProgression[offsetIdx] ?? '0', 10);

    this.currentChordShape = CHORDS[chordName] ?? CHORDS.min7;
    this.currentChordRoot = rootOffset;

    // Build MIDI chord for pad
    const chord = this.currentChordShape.intervals.map(i => this.rootNote + rootOffset + i);
    if (this._onChordChange) {
      this._onChordChange(chord);
    }

    this.chordIndex++;

    // Schedule next chord change
    const jitter = (this.rng() - 0.5) * this.chordDuration * 0.2;
    this.chordTimer = window.setTimeout(
      () => this.advanceChord(),
      (this.chordDuration + jitter) * 1000,
    );
  }

  // ── Melody phrases ──

  private schedulePhrase(): void {
    if (!this.isActive || this.volume <= 0 || this.tempo <= 0) return;

    // Pick a new phrase
    this.phraseIndex = Math.floor(this.rng() * PHRASES.length);
    this.currentPhrase = PHRASES[this.phraseIndex];
    this.noteInPhrase = 0;

    this.playNextNote();
  }

  private playNextNote(): void {
    if (!this.isActive || this.volume <= 0) return;

    if (this.noteInPhrase >= this.currentPhrase.length) {
      // Phrase done — wait, then start a new one
      const pauseBetweenPhrases = this.tempo * (1.5 + this.rng() * 2);
      this.melodyTimer = window.setTimeout(
        () => this.schedulePhrase(),
        pauseBetweenPhrases * 1000,
      );
      return;
    }

    const interval = this.currentPhrase[this.noteInPhrase];
    this.noteInPhrase++;

    if (interval === -1) {
      // Rest — skip this beat
      const restDuration = this.tempo * (0.5 + this.rng() * 0.5);
      this.melodyTimer = window.setTimeout(
        () => this.playNextNote(),
        restDuration * 1000,
      );
      return;
    }

    // Transpose interval to current chord root
    const midi = this.rootNote + this.currentChordRoot + interval;
    const note = midiToNote(midi);
    const duration = this.tempo * (0.4 + this.rng() * 0.4);

    this.melodySynth.triggerAttackRelease(note, duration);

    // Subtle velocity variation via volume
    const velocityVar = 0.7 + this.rng() * 0.3;
    this.melodySynth.volume.value = -8 - (1 - velocityVar) * 6;

    // Schedule next note in phrase
    const noteSpacing = this.tempo * (0.6 + this.rng() * 0.4);
    this.melodyTimer = window.setTimeout(
      () => this.playNextNote(),
      noteSpacing * 1000,
    );
  }

  // ── Shimmer textures ──

  private scheduleShimmer(): void {
    if (!this.isActive) return;

    const playShimmer = () => {
      if (!this.isActive || this.volume <= 0) return;

      // High note from current chord, transposed up
      const intervals = this.currentChordShape.intervals;
      const interval = intervals[Math.floor(this.rng() * intervals.length)];
      const midi = this.rootNote + this.currentChordRoot + interval + 24; // 2 octaves up
      const note = midiToNote(midi);

      this.shimmerSynth.triggerAttackRelease(note, 2 + this.rng() * 3);

      // Sometimes play a second shimmer note for a cluster
      if (this.rng() < 0.3) {
        const midi2 = midi + (this.rng() < 0.5 ? 3 : 4); // minor or major third
        setTimeout(() => {
          if (this.isActive) {
            this.shimmerSynth.triggerAttackRelease(midiToNote(midi2), 1.5 + this.rng() * 2);
          }
        }, 200 + this.rng() * 500);
      }

      // Schedule next shimmer — sparse, every 15-40 seconds
      const nextTime = 15 + this.rng() * 25;
      this.shimmerTimer = window.setTimeout(playShimmer, nextTime * 1000);
    };

    // First shimmer after a random delay
    this.shimmerTimer = window.setTimeout(playShimmer, (8 + this.rng() * 15) * 1000);
  }
}
