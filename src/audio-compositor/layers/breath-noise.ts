/**
 * BreathNoiseLayer — shaped noise that mimics user's breathing.
 * Bandpass around 1-2kHz, amplitude tracks breath.value.
 * Subliminal "breathing with you" sensation.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class BreathNoiseLayer implements AudioLayer {
  name = 'breath-noise';

  private noise: Tone.Noise;
  private filter: Tone.Filter;
  private gain: Tone.Gain;
  private targetVolume = 0.15;

  constructor() {
    this.noise = new Tone.Noise('white');
    this.filter = new Tone.Filter({ frequency: 1200, type: 'bandpass', Q: 1.5 });
    this.gain = new Tone.Gain(0);

    this.noise.connect(this.filter);
    this.filter.connect(this.gain);
  }

  connect(wet: Tone.ToneAudioNode, _dry: Tone.ToneAudioNode): void {
    // Breath noise through reverb sounds like breathing in a space
    this.gain.connect(wet);
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    this.targetVolume = p.breathNoise.volume;
    if (p.breathNoise.volume === 0) {
      this.gain.gain.rampTo(0, Math.max(0.01, rampTime));
    }
  }

  update(inputs: WorldInputs, _dt: number): void {
    if (this.targetVolume <= 0) return;
    // Amplitude follows breath — inhale = louder, exhale = softer
    const vol = inputs.breathValue * this.targetVolume * 0.05;
    this.gain.gain.rampTo(vol, 0.15);

    // Filter shifts with breath phase — slightly brighter on inhale
    const freq = 800 + inputs.breathValue * 800;
    this.filter.frequency.rampTo(freq, 0.2);
  }

  start(): void { this.noise.start(); }
  stop(rampTime = 3): void { this.gain.gain.rampTo(0, rampTime); }

  dispose(): void {
    this.noise.dispose();
    this.filter.dispose();
    this.gain.dispose();
  }
}
