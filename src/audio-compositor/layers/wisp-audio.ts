/**
 * WispAudioLayer — gives the presence wisp a sonic identity.
 *
 * A very quiet, high FM tone that follows the wisp's 3D position
 * via a Tone.Panner3D. When the wisp moves, you hear it move.
 * Breath modulates the tone subtly — inhale brightens, exhale darkens.
 * Voice energy makes it resonate (the wisp "listens" when you speak).
 */

import * as Tone from 'tone';
import type { AudioLayer, AudioPreset } from '../types';
import type { WorldInputs } from '../../compositor/types';

export class WispAudioLayer implements AudioLayer {
  name = 'wisp-audio';

  private osc: Tone.FMSynth;
  private panner: Tone.Panner3D;
  private filter: Tone.Filter;
  private gain: Tone.Gain;
  private volume = 0.1;

  constructor() {
    // Ethereal high tone — quiet, crystalline
    this.osc = new Tone.FMSynth({
      harmonicity: 8,
      modulationIndex: 4,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 3, decay: 1, sustain: 0.8, release: 5 },
      modulationEnvelope: { attack: 2, decay: 0.5, sustain: 0.6, release: 3 },
    });
    this.osc.volume.value = -18;

    this.filter = new Tone.Filter({ frequency: 2000, type: 'lowpass', Q: 1 });

    // 3D panner — follows wisp position
    this.panner = new Tone.Panner3D({
      positionX: 0,
      positionY: 0,
      positionZ: -1.5,
      rolloffFactor: 2,
      distanceModel: 'inverse',
      maxDistance: 10,
      refDistance: 1,
    });

    this.gain = new Tone.Gain(0);

    this.osc.connect(this.filter);
    this.filter.connect(this.panner);
    this.panner.connect(this.gain);
  }

  connect(wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void {
    this.gain.connect(wet);   // through reverb — wisp sounds spacious
    this.gain.connect(dry);
  }

  applyPreset(_p: AudioPreset, rampTime: number): void {
    const t = Math.max(0.01, rampTime);
    this.gain.gain.rampTo(this.volume, t);
  }

  /** Set wisp volume (can be controlled per-stage or disabled) */
  setVolume(v: number): void {
    this.volume = v;
    this.gain.gain.rampTo(v, 0.5);
  }

  update(inputs: WorldInputs, _dt: number): void {
    const br = inputs.breathValue;

    // Filter opens on inhale (brighter), closes on exhale (warmer)
    const freq = 1000 + br * 2000;
    this.filter.frequency.rampTo(freq, 0.2);

    // Voice energy → wisp resonates (mod index increases = richer harmonics)
    const voiceResonance = 4 + inputs.voiceEnergy * 8;
    this.osc.modulationIndex.rampTo(voiceResonance, 0.3);
  }

  /** Update the wisp's 3D position (call from render with presence mesh position) */
  setPosition(x: number, y: number, z: number): void {
    this.panner.positionX.rampTo(x * 3, 0.1);  // scale for audible panning
    this.panner.positionY.rampTo(y * 3, 0.1);
    this.panner.positionZ.rampTo(z, 0.1);
  }

  start(): void {
    this.osc.triggerAttack('C6'); // very high, quiet, crystalline
  }

  stop(rampTime = 3): void {
    this.gain.gain.rampTo(0, rampTime);
    setTimeout(() => this.osc.triggerRelease(), rampTime * 1000);
  }

  dispose(): void {
    this.osc.dispose();
    this.filter.dispose();
    this.panner.dispose();
    this.gain.dispose();
  }
}
