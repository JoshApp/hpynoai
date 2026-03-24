/**
 * SpatialLayer — auto-panner for envelopment.
 * Wraps the pad output with slow L/R movement.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class SpatialLayer implements AudioLayer {
  name = 'spatial';

  private panner: Tone.AutoPanner;
  private input: Tone.Gain;

  constructor() {
    this.input = new Tone.Gain(1);
    this.panner = new Tone.AutoPanner({ frequency: 0.08, depth: 0.4, wet: 1 }).start();
    this.input.connect(this.panner);
  }

  /** Other layers connect TO this layer's input, and it outputs to wet/dry */
  get inputNode(): Tone.Gain { return this.input; }

  connect(wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void {
    this.panner.connect(wet);
    this.panner.connect(dry);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.panner.frequency.rampTo(p.spatial.rate, t);
    this.panner.depth.rampTo(p.spatial.depth, t);
  }

  update(_inputs: WorldInputs, _dt: number): void {}

  start(): void {}  // AutoPanner already started in constructor
  stop(): void {}

  dispose(): void {
    this.input.dispose();
    this.panner.dispose();
  }
}
