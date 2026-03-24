/**
 * SubPulseLayer — sub-audible amplitude throb at entrainment frequency.
 * Felt more than heard. Reinforces binaural through amplitude pathway.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class SubPulseLayer implements AudioLayer {
  name = 'sub-pulse';

  private osc: Tone.Oscillator;
  private lfo: Tone.LFO;
  private lfoGain: Tone.Gain;
  private gain: Tone.Gain;

  constructor() {
    // Sub-bass oscillator
    this.osc = new Tone.Oscillator({ type: 'sine', frequency: 40 });

    // LFO modulates the gain at entrainment frequency
    this.lfoGain = new Tone.Gain(0);
    this.lfo = new Tone.LFO({ frequency: 6, min: 0, max: 1, type: 'sine' });
    this.lfo.connect(this.lfoGain.gain);

    this.gain = new Tone.Gain(0);
    this.osc.connect(this.lfoGain);
    this.lfoGain.connect(this.gain);
  }

  connect(_wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void {
    // Sub goes dry only (reverb muddies sub-bass)
    this.gain.connect(dry);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.lfo.frequency.rampTo(p.subPulse.frequency, t);
    this.lfo.max = p.subPulse.depth;
    this.gain.gain.rampTo(p.subPulse.volume, t);
  }

  update(_inputs: WorldInputs, _dt: number): void {}

  start(): void {
    this.osc.start();
    this.lfo.start();
  }

  stop(rampTime = 3): void { this.gain.gain.rampTo(0, rampTime); }

  dispose(): void {
    this.osc.dispose();
    this.lfo.dispose();
    this.lfoGain.dispose();
    this.gain.dispose();
  }
}
