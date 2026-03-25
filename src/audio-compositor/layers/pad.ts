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
    // Warm, lush pad — low harmonicity for smoothness, gentle modulation
    this.synth = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 1.5,
      modulationIndex: 2,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 4, decay: 2, sustain: 0.85, release: 8 },
      modulationEnvelope: { attack: 3, decay: 1, sustain: 0.6, release: 6 },
    });
    this.synth.volume.value = -8;

    // Gentle lowpass — rolls off high harmonics for warmth
    this.filter = new Tone.Filter({ frequency: 500, type: 'lowpass', Q: 0.8, rolloff: -24 });
    // Slow chorus — adds stereo width and subtle detuning
    this.chorus = new Tone.Chorus({ frequency: 0.15, delayTime: 4, depth: 0.5, wet: 0.35 }).start();
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
