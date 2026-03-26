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
    // Deep, evolving drone — singing bowl / bowed glass character
    // Low harmonicity = smooth fundamental, modIndex LFO creates timbral movement
    this.synth = new Tone.FMSynth({
      harmonicity: 1,
      modulationIndex: 2,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 8, decay: 3, sustain: 1, release: 15 },
      modulationEnvelope: { attack: 6, decay: 2, sustain: 0.7, release: 10 },
    });
    this.synth.volume.value = -3; // less internal attenuation for audibility

    this.gain = new Tone.Gain(0);
    this.synth.connect(this.gain);

    // Very slow LFO — timbral evolution over 50+ seconds
    // Feels like the tone is alive, not static
    this.lfo = new Tone.LFO({ frequency: 0.015, min: 0.5, max: 4, type: 'sine' });
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
