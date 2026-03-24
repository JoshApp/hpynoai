/**
 * Audio compositor types — layer interface, presets, master bus config.
 */

import type * as Tone from 'tone';
import type { WorldInputs } from '../compositor/types';

// ── Audio layer interface ──

export interface AudioLayer {
  name: string;
  applyPreset(preset: AudioPreset, rampTime: number): void;
  update(inputs: WorldInputs, dt: number): void;
  connect(wet: Tone.ToneAudioNode, dry: Tone.ToneAudioNode): void;
  start(): void;
  stop(rampTime?: number): void;
  dispose(): void;
}

// ── Audio preset (one per stage) ──

export interface AudioPreset {
  binaural: {
    carrierFreq: number;
    beatFreq: number;
    volume: number;
  };
  drone: {
    rootNote: number;
    harmonicity: number;
    modIndex: number;
    volume: number;
  };
  pad: {
    chord: number[];
    filterMax: number;
    warmth: number;
    chorusRate: number;
    volume: number;
  };
  noise: {
    type: 'pink' | 'brown' | 'white';
    filterFreq: number;
    volume: number;
  };
  subPulse: {
    frequency: number;
    depth: number;
    volume: number;
  };
  breathNoise: {
    volume: number;
  };
  spatial: {
    rate: number;
    depth: number;
  };
  melody: {
    rootNote: number;
    volume: number;
    tempo: number;
  };
  background: {
    url: string | null;
    volume: number;
  };
  reverb: {
    decay: number;
    wet: number;
  };
  master: {
    volume: number;
  };
}

// ── Default preset (sensible starting point) ──

export const DEFAULT_AUDIO_PRESET: AudioPreset = {
  binaural: { carrierFreq: 120, beatFreq: 10, volume: 0.5 },
  drone: { rootNote: 36, harmonicity: 2, modIndex: 3, volume: 0.3 },
  pad: { chord: [48, 52, 55, 60], filterMax: 1200, warmth: 0.7, chorusRate: 0.3, volume: 0.4 },
  noise: { type: 'pink', filterFreq: 400, volume: 0.3 },
  subPulse: { frequency: 6, depth: 0.3, volume: 0.2 },
  breathNoise: { volume: 0.15 },
  spatial: { rate: 0.08, depth: 0.4 },
  melody: { rootNote: 48, volume: 0.3, tempo: 5 },
  background: { url: null, volume: 0.3 },
  reverb: { decay: 4, wet: 0.65 },
  master: { volume: 0.5 },
};

// ── Utility ──

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNote(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Deep merge partial preset onto base */
export function mergePreset(base: AudioPreset, partial: Partial<DeepPartial<AudioPreset>>): AudioPreset {
  const result = { ...base };
  for (const key of Object.keys(partial) as (keyof AudioPreset)[]) {
    if (partial[key] && typeof partial[key] === 'object') {
      (result as Record<string, unknown>)[key] = { ...(base[key] as object), ...(partial[key] as object) };
    }
  }
  return result;
}

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? Partial<T[P]> : T[P] };
