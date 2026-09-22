import type { SessionPackage } from '../schema';

/** Three contiguous stages: 0–40, 40–100, 100–130. */
export function fixturePackage(): SessionPackage {
  return {
    schema: 2,
    id: 'fixture',
    title: 'Fixture',
    durationSec: 130,
    rating: 'adult',
    tags: [],
    intensity: 3,
    audio: {
      bed: { file: 'bed.webm', fileMp3: 'bed.mp3', loop: true, gainDb: -6 },
      stages: [
        { name: 'a', file: 'a.webm', fileMp3: 'a.mp3', duration: 40 },
        { name: 'b', file: 'b.webm', fileMp3: 'b.mp3', duration: 60 },
        { name: 'c', file: 'c.webm', fileMp3: 'c.mp3', duration: 30 },
      ],
    },
    cues: [
      { t: 0, type: 'anchor', mode: 'settle' },
      { t: 2, type: 'intensity', value: 0.2, ramp: 0 },
      { t: 5, type: 'breath', dur: 20, pattern: { inhale: 4, holdIn: 1, exhale: 5, holdOut: 0 } },
      { t: 35, type: 'gate', window: 6, prompt: 'do you want to go deeper?' },
      { t: 41, type: 'trigger', kind: 'drop' },
      { t: 60, type: 'intensity', value: 0.8, ramp: 10 },
      { t: 95, type: 'gate', window: 5, prompt: 'surrender?' },
      { t: 100, type: 'anchor', mode: 'pendulum' },
    ],
    text: {
      stages: [
        { name: 'a', lines: [
          { start: 1, end: 4, text: 'you are here', words: [{ w: 'you', s: 1, e: 1.5 }, { w: 'are', s: 1.6, e: 2 }, { w: 'here', s: 2.2, e: 4 }] },
          { start: 10, end: 12, text: 'breathe', words: [{ w: 'breathe', s: 10, e: 12 }] },
        ] },
        { name: 'b', lines: [
          { start: 0.5, end: 3, text: 'deeper now', words: [{ w: 'deeper', s: 0.5, e: 1.2 }, { w: 'now', s: 1.4, e: 3 }] },
        ] },
      ],
    },
  };
}
