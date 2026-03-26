/**
 * Stage audio preset derivation — pure function, no side effects.
 *
 * Given a session stage and audio profile, produces the AudioPreset
 * that should drive the audio compositor for that stage.
 * Deeper stages = darker, simpler, more reverb.
 */

import type { SessionStage, AudioProfile } from './session';
import type { AudioPreset } from './audio-compositor';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Derive an audio preset from session stage config.
 * All values are position-derived from stage.intensity — no mutable state.
 */
export function buildStageAudioPreset(
  stage: SessionStage,
  audioProfile: AudioProfile,
  binauralVolume: number,
): Partial<AudioPreset> {
  const i = stage.intensity;
  const rootNote = 48; // could derive from session

  const preset: Partial<AudioPreset> = {
    binaural: {
      carrierFreq: audioProfile.carrierFreq,
      beatFreq: lerp(audioProfile.binauralRange[0], audioProfile.binauralRange[1], i),
      volume: binauralVolume,
    },
    pad: {
      chord: [rootNote, rootNote + 4, rootNote + 7, rootNote + 12],
      filterMax: 1500 - i * 900,
      warmth: 0.5 + i * 0.4,
      chorusRate: 0.3,
      volume: 0.5 + i * 0.2,
    },
    drone: {
      rootNote: rootNote - 12,
      harmonicity: 2,
      modIndex: 2 + i * 4,
      volume: 0.4 + i * 0.2,
    },
    noise: {
      type: i > 0.7 ? 'brown' : 'pink',
      filterFreq: 500 - i * 200,
      volume: 0.3 + i * 0.2,
    },
    subPulse: {
      frequency: lerp(audioProfile.binauralRange[0], audioProfile.binauralRange[1], i),
      depth: 0.2 + i * 0.3,
      volume: 0.25 + i * 0.15,
    },
    breathNoise: {
      volume: 0.15 + i * 0.15,
    },
    melody: {
      rootNote,
      volume: Math.max(0, 0.45 - i * 0.45),
      tempo: 4 + i * 3,
    },
    reverb: {
      decay: 3 + i * 4,
      wet: 0.5 + i * 0.25,
    },
  };

  // Apply per-stage ambient overrides
  if (stage.ambient) {
    const a = stage.ambient;
    if (a.padLevel !== undefined) preset.pad!.volume = a.padLevel;
    if (a.noiseLevel !== undefined) preset.noise!.volume = a.noiseLevel;
    if (a.melodyLevel !== undefined) preset.melody!.volume = a.melodyLevel;
    if (a.filterMax !== undefined) preset.pad!.filterMax = a.filterMax;
    if (a.warmth !== undefined) preset.pad!.warmth = a.warmth;
  }

  return preset;
}

/** Build the initial session audio preset (first stage values). */
export function buildSessionAudioPreset(
  session: { audio: AudioProfile; stages: SessionStage[] },
  binauralVolume: number,
  rootNote = 48,
): Partial<AudioPreset> {
  return {
    binaural: {
      carrierFreq: session.audio.carrierFreq,
      beatFreq: session.audio.binauralRange[0],
      volume: binauralVolume,
    },
    drone: { rootNote: rootNote - 12, harmonicity: 2, modIndex: 3, volume: 0.4 },
    pad: { chord: [rootNote, rootNote + 4, rootNote + 7, rootNote + 12], filterMax: 1200, warmth: session.audio.warmth, chorusRate: 0.3, volume: 0.5 },
    noise: { type: 'pink', filterFreq: 400, volume: 0.3 },
    melody: { rootNote, volume: 0.4, tempo: 5 },
  };
}
