/**
 * MelodyActor — sparse pentatonic notes with seeded RNG.
 * Same seed = same melody sequence = reproducible sessions.
 * FM synth with bell-like timbre.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import { midiToNote } from '../types';
import { createRNG } from '../rng';
import type { WorldInputs } from '../../compositor/types';

const PENTATONIC = [0, 3, 5, 7, 10, 12, 15, 17, 19];

export class MelodyActor implements AudioLayer {
  name = 'melody';

  private synth: Tone.FMSynth;
  private gain: Tone.Gain;
  private timer: number | null = null;
  private rng: () => number;
  private lastNoteIdx = 0;
  private rootNote = 48;
  private tempo = 5;
  private volume = 0.3;
  private isActive = false;

  constructor(seed: number) {
    this.rng = createRNG(seed);

    this.synth = new Tone.FMSynth({
      harmonicity: 5,
      modulationIndex: 8,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 1.5, decay: 0.5, sustain: 0.6, release: 3 },
      modulationEnvelope: { attack: 1, decay: 0.2, sustain: 0.5, release: 2 },
    });
    this.synth.volume.value = -10;

    this.gain = new Tone.Gain(0);
    this.synth.connect(this.gain);
  }

  connect(wet: Tone.ToneAudioNode, _dry: Tone.ToneAudioNode): void {
    // Melody goes through reverb for ethereal quality
    this.gain.connect(wet);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.rootNote = p.melody.rootNote;
    this.tempo = p.melody.tempo;
    this.volume = p.melody.volume;
    this.gain.gain.rampTo(p.melody.volume, t);
  }

  update(_inputs: WorldInputs, _dt: number): void {}

  start(): void {
    this.isActive = true;
    this.scheduleMelody();
  }

  stop(rampTime = 3): void {
    this.isActive = false;
    this.gain.gain.rampTo(0, rampTime);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  dispose(): void {
    this.isActive = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.synth.dispose();
    this.gain.dispose();
  }

  private scheduleMelody(): void {
    if (!this.isActive || this.tempo <= 0) return;

    const playNote = () => {
      if (!this.isActive) return;

      // Seeded random walk
      const step = this.rng() < 0.7
        ? (this.rng() < 0.5 ? -1 : 1)
        : Math.floor(this.rng() * 3) - 1;

      this.lastNoteIdx = Math.max(0, Math.min(PENTATONIC.length - 1, this.lastNoteIdx + step));
      const semitone = PENTATONIC[this.lastNoteIdx];
      const note = midiToNote(this.rootNote + semitone);
      const duration = this.tempo * 0.7;

      if (this.volume > 0) {
        this.synth.triggerAttackRelease(note, duration);
      }

      const jitter = (this.rng() - 0.5) * this.tempo * 0.3;
      this.timer = window.setTimeout(playNote, (this.tempo + jitter) * 1000);
    };

    this.timer = window.setTimeout(playNote, this.tempo * 1000);
  }
}
