/**
 * DroneLayer — evolving FM tone that morphs timbre with depth.
 * Holds a single sustained note. modulationIndex controls richness.
 * LFO on modIndex creates slow timbral evolution.
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import { midiToNote } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class DroneLayer implements AudioLayer {
  name = 'drone';

  private synth: Tone.FMSynth;
  private gain: Tone.Gain;
  private lfo: Tone.LFO;
  private currentNote = 'C2';

  constructor() {
    this.synth = new Tone.FMSynth({
      harmonicity: 2,
      modulationIndex: 3,
      oscillator: { type: 'sine' },
      modulation: { type: 'triangle' },
      envelope: { attack: 5, decay: 2, sustain: 1, release: 10 },
      modulationEnvelope: { attack: 4, decay: 1, sustain: 0.8, release: 8 },
    });
    this.synth.volume.value = -8;

    this.gain = new Tone.Gain(0);
    this.synth.connect(this.gain);

    // Slow LFO on modulation index for timbral evolution
    this.lfo = new Tone.LFO({ frequency: 0.02, min: 1, max: 5, type: 'sine' });
    this.lfo.connect(this.synth.modulationIndex);
  }

  connect(wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void {
    this.gain.connect(wet);  // mostly reverb
    this.gain.connect(dry);      // some dry
  }

  applyPreset(p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.currentNote = midiToNote(p.drone.rootNote);
    this.synth.set({
      harmonicity: p.drone.harmonicity,
      modulationIndex: p.drone.modIndex,
    });
    this.gain.gain.rampTo(p.drone.volume, t);
    this.lfo.min = Math.max(0.5, p.drone.modIndex * 0.3);
    this.lfo.max = p.drone.modIndex * 1.5;
  }

  update(_inputs: WorldInputs, _dt: number): void {}

  start(): void {
    this.lfo.start();
    this.synth.triggerAttack(this.currentNote);
  }

  stop(rampTime = 3): void {
    this.gain.gain.rampTo(0, rampTime);
    setTimeout(() => this.synth.triggerRelease(), rampTime * 1000);
  }

  dispose(): void {
    this.synth.dispose();
    this.gain.dispose();
    this.lfo.dispose();
  }
}
