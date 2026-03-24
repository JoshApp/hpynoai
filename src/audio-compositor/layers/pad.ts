/**
 * PadLayer — FM synth chord bed with breath-modulated filter + chorus.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import { midiToNote } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class PadLayer implements AudioLayer {
  name = 'pad';

  private synth: Tone.PolySynth;
  private filter: Tone.Filter;
  private chorus: Tone.Chorus;
  private gain: Tone.Gain;
  private currentChord: string[] = [];
  private filterMax = 1200;
  private warmth = 0.7;

  constructor() {
    this.synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 2,
      modulationIndex: 3,
      oscillator: { type: 'sine' },
      modulation: { type: 'triangle' },
      envelope: { attack: 3, decay: 1, sustain: 0.9, release: 5 },
      modulationEnvelope: { attack: 2, decay: 0.5, sustain: 0.8, release: 4 },
    });
    this.synth.volume.value = -6;

    this.filter = new Tone.Filter({ frequency: 600, type: 'lowpass', Q: 1.5, rolloff: -24 });
    this.chorus = new Tone.Chorus({ frequency: 0.3, delayTime: 3.5, depth: 0.6, wet: 0.4 }).start();
    this.gain = new Tone.Gain(0);

    this.synth.connect(this.filter);
    this.filter.connect(this.chorus);
    this.chorus.connect(this.gain);
  }

  connect(wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void {
    this.gain.connect(wet);
    this.gain.connect(dry);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.filterMax = p.pad.filterMax;
    this.warmth = p.pad.warmth;

    this.filter.Q.rampTo(1 + p.pad.warmth * 2, t);
    this.chorus.frequency.value = p.pad.chorusRate;
    this.gain.gain.rampTo(p.pad.volume, t);

    const newChord = p.pad.chord.map(midiToNote);
    const chordKey = newChord.join(',');
    if (chordKey !== this.currentChord.join(',')) {
      this.synth.releaseAll();
      this.currentChord = newChord;
      // Slight delay so release starts before new attack
      setTimeout(() => this.synth.triggerAttack(this.currentChord), 50);
    }
  }

  update(inputs: WorldInputs, _dt: number): void {
    const br = inputs.breathValue;
    // Subtle breath-driven filter sweep (25% of range)
    const baseFreq = 200 + this.warmth * 300;
    const breathFreq = baseFreq + br * this.filterMax * 0.25;
    this.filter.frequency.rampTo(breathFreq, 0.3);
  }

  start(): void {
    if (this.currentChord.length > 0) {
      this.synth.triggerAttack(this.currentChord);
    }
  }

  stop(rampTime = 3): void {
    this.gain.gain.rampTo(0, rampTime);
    setTimeout(() => this.synth.releaseAll(), rampTime * 1000);
  }

  dispose(): void {
    this.synth.dispose();
    this.filter.dispose();
    this.chorus.dispose();
    this.gain.dispose();
  }
}
