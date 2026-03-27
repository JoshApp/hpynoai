/**
 * Stage audio preset derivation — pure function, no side effects.
 *
 * Given a session stage and audio profile, produces the AudioPreset
 * that should drive the audio compositor for that stage.
 * Deeper stages = darker, simpler, more reverb.
 *
 * Mobile speakers can't reproduce frequencies below ~250 Hz.
 * On mobile: drone shifts up 2 octaves, binaural carrier raised to 220 Hz,
 * sub-pulse disabled, overall gains reduced to prevent clipping.
 */

import type { SessionStage, AudioProfile } from './session';
import type { AudioPreset } from './audio-compositor';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Cached mobile speaker detection (no headphone jack / small screen = likely speakers) */
let _isMobileSpeaker: boolean | null = null;
export function isMobileSpeaker(): boolean {
  if (_isMobileSpeaker !== null) return _isMobileSpeaker;
  _isMobileSpeaker = (
    'ontouchstart' in window || navigator.maxTouchPoints > 0
  ) && window.innerWidth < 768;
  return _isMobileSpeaker;
}

/** Reset cached value (e.g. on resize or when headphones connect) */
export function resetMobileSpeakerDetection(): void {
  _isMobileSpeaker = null;
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

  const mobile = isMobileSpeaker();

  // On mobile speakers: raise carrier into audible range, shift drone up 2 octaves
  const carrierFreq = mobile ? Math.max(220, audioProfile.carrierFreq) : audioProfile.carrierFreq;
  const droneRoot = mobile ? rootNote : rootNote - 12; // mobile: C3 (131Hz) instead of C1 (32Hz)

  // Mobile gain scaling — reduce total summed energy to prevent clipping
  const gm = mobile ? 0.6 : 1;

  const preset: Partial<AudioPreset> = {
    binaural: {
      carrierFreq,
      beatFreq: lerp(audioProfile.binauralRange[0], audioProfile.binauralRange[1], i),
      volume: binauralVolume * (mobile ? 0.7 : 1),
    },
    pad: {
      chord: [rootNote, rootNote + 4, rootNote + 7, rootNote + 12],
      filterMax: 1500 - i * 900,
      warmth: 0.5 + i * 0.4,
      chorusRate: 0.3,
      volume: (0.5 + i * 0.2) * gm,
    },
    drone: {
      rootNote: droneRoot,
      harmonicity: 2,
      modIndex: 2 + i * 4,
      volume: (0.3 + i * 0.15) * gm,
    },
    noise: {
      type: i > 0.7 ? 'brown' : 'pink',
      filterFreq: mobile ? Math.max(400, 500 - i * 200) : 500 - i * 200,
      volume: (0.3 + i * 0.2) * (mobile ? 0.5 : 1), // noise dominates on mobile, pull it back
    },
    subPulse: {
      frequency: lerp(audioProfile.binauralRange[0], audioProfile.binauralRange[1], i),
      depth: mobile ? 0 : 0.15 + i * 0.2,           // disable on mobile — inaudible, wastes headroom
      volume: mobile ? 0 : 0.12 + i * 0.08,
    },
    breathNoise: {
      volume: (0.15 + i * 0.15) * gm,
    },
    melody: {
      rootNote,
      volume: Math.max(0, 0.45 - i * 0.45) * gm,
      tempo: 4 + i * 3,
    },
    reverb: {
      decay: mobile ? 2 + i * 2 : 3 + i * 4, // shorter reverb on mobile — less mud
      wet: mobile ? 0.35 + i * 0.15 : 0.5 + i * 0.25,
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
  const mobile = isMobileSpeaker();
  const gm = mobile ? 0.6 : 1;
  return {
    binaural: {
      carrierFreq: mobile ? Math.max(220, session.audio.carrierFreq) : session.audio.carrierFreq,
      beatFreq: session.audio.binauralRange[0],
      volume: binauralVolume * (mobile ? 0.7 : 1),
    },
    drone: { rootNote: mobile ? rootNote : rootNote - 12, harmonicity: 2, modIndex: 3, volume: 0.4 * gm },
    pad: { chord: [rootNote, rootNote + 4, rootNote + 7, rootNote + 12], filterMax: 1200, warmth: session.audio.warmth, chorusRate: 0.3, volume: 0.5 * gm },
    noise: { type: 'pink', filterFreq: mobile ? 400 : 400, volume: 0.3 * (mobile ? 0.5 : 1) },
    subPulse: mobile ? { frequency: 6, depth: 0, volume: 0 } : undefined,
    melody: { rootNote, volume: 0.4 * gm, tempo: 5 },
    reverb: mobile ? { decay: 2, wet: 0.35 } : undefined,
  } as Partial<AudioPreset>;
}
