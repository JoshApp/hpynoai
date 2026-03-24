/**
 * NoiseLayer — filtered noise for wind/ocean texture.
 * Breath modulates filter inversely (exhale = more open = wind).
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class NoiseLayer implements AudioLayer {
  name = 'noise';

  private noise: Tone.Noise;
  private filter: Tone.Filter;
  private gain: Tone.Gain;
  private filterBase = 400;

  constructor() {
    this.noise = new Tone.Noise('pink');
    this.filter = new Tone.Filter({ frequency: 400, type: 'bandpass', Q: 0.5 });
    this.gain = new Tone.Gain(0);

    this.noise.connect(this.filter);
    this.filter.connect(this.gain);
  }

  connect(wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void {
    this.gain.connect(wet);  // noise sounds great with reverb
    this.gain.connect(dry);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.filterBase = p.noise.filterFreq;

    if (p.noise.type !== this.noise.type) {
      this.noise.type = p.noise.type;
    }

    this.gain.gain.rampTo(p.noise.volume, t);
  }

  update(inputs: WorldInputs, _dt: number): void {
    // Inverse breath: exhale = filter opens = wind
    const br = inputs.breathValue;
    const freq = this.filterBase * 0.5 + (1 - br) * this.filterBase * 0.3;
    this.filter.frequency.rampTo(freq, 0.3);
  }

  start(): void { this.noise.start(); }
  stop(rampTime = 3): void { this.gain.gain.rampTo(0, rampTime); }

  dispose(): void {
    this.noise.dispose();
    this.filter.dispose();
    this.gain.dispose();
  }
}
