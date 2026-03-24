/**
 * BinauralLayer — entrainment carrier.
 * Two sine oscillators panned L/R, beat frequency = difference.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class BinauralLayer implements AudioLayer {
  name = 'binaural';

  private left: Tone.Oscillator;
  private right: Tone.Oscillator;
  private merge: Tone.Merge;
  private gain: Tone.Gain;

  constructor() {
    this.left = new Tone.Oscillator({ type: 'sine', frequency: 120 });
    this.right = new Tone.Oscillator({ type: 'sine', frequency: 130 });
    this.merge = new Tone.Merge();
    this.gain = new Tone.Gain(0);

    this.left.connect(this.merge, 0, 0);
    this.right.connect(this.merge, 0, 1);
    this.merge.connect(this.gain);
  }

  connect(wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void {
    // Binaural goes mostly dry (spatial precision matters)
    this.gain.connect(dry);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.left.frequency.rampTo(p.binaural.carrierFreq, t);
    this.right.frequency.rampTo(p.binaural.carrierFreq + p.binaural.beatFreq, t);
    this.gain.gain.rampTo(p.binaural.volume, t);
  }

  update(_inputs: WorldInputs, _dt: number): void {}

  start(): void {
    this.left.start();
    this.right.start();
  }

  stop(rampTime = 3): void {
    this.gain.gain.rampTo(0, rampTime);
  }

  dispose(): void {
    this.left.dispose();
    this.right.dispose();
    this.merge.dispose();
    this.gain.dispose();
  }
}
