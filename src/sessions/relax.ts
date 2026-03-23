import type { SessionConfig } from '../session';

export const relax: SessionConfig = {
  id: 'relax',
  name: 'Relax',
  description: 'A gentle descent into deep relaxation using Ericksonian pacing and leading.',
  icon: '\u{1F9D8}',
  theme: {
    textColor: '#c8b8ff',
    textGlow: 'rgba(160, 120, 255, 0.6)',
    primaryColor: [0.45, 0.25, 0.85],
    secondaryColor: [0.25, 0.3, 0.75],
    accentColor: [0.6, 0.4, 1.0],
    bgColor: [0.03, 0.02, 0.08],
    particleColor: [0.5, 0.35, 0.9],
    breatheColor: 'rgba(160, 120, 255, 0.35)',
  },
  audio: {
    binauralRange: [10, 4],
    carrierFreq: 120,
    droneFreq: 60,
    droneFifth: 90,
    lfoSpeed: 0.08,
    filterCutoff: 600,
    warmth: 0.7,
    backgroundTrack: 'audio/relax/ambient.mp3',
    backgroundVolume: 0.25,
  },
  stages: [
    {
      // Stage 1: Teach breathing first — interaction runs immediately,
      // no text until it completes. Once 4 cycles sync, it dissolves
      // and narration begins.
      name: 'induction',
      duration: 45,
      intensity: 0.25,
      texts: [
        'you are watching the screen',
        'notice your breath\nmoving in and out',
        'you can feel\nyour body in the chair',
        'your eyes are open\nand that is fine',
        'notice the shapes\nas they move',
        'you are here\nright now',
      ],
      textInterval: 7,
      breathCycle: 8,
      breathPattern: { inhale: 4, exhale: 4 }, // simple equal breathing to learn
      spiralSpeed: 1.0,
      interactions: [
        {
          type: 'breath-sync',
          triggerAt: 0,
          duration: 30,
        },
      ],
    },
    {
      // Stage 2: Pure narration — breathing slows, slight hold on inhale
      name: 'deepening',
      duration: 50,
      intensity: 0.5,
      texts: [
        'and as you notice\nyou begin to relax',
        'each breath carries you\na little deeper',
        'the more you watch\nthe more you let go',
        'your shoulders dropping\njust a little',
        'that heaviness\nis comfort',
        'sinking gently\nwith each exhale',
      ],
      textInterval: 8,
      breathCycle: 9,
      breathPattern: { inhale: 4, holdIn: 1, exhale: 4 }, // gentle hold at top
      spiralSpeed: 0.85,
    },
    {
      // Stage 3: Deep trance — 4-7-8 breathing (calming)
      name: 'trance',
      duration: 60,
      intensity: 0.75,
      texts: [
        'you might notice\nhow comfortable this feels',
        'perhaps deeper\nthan you expected',
        'and that is perfectly fine',
        'your unconscious mind\nknows what to do',
        'there is nothing\nyou need to figure out',
        'just allow this\nto happen',
        'deeper now\nwithout even trying',
      ],
      textInterval: 9,
      breathCycle: 10,
      breathPattern: { inhale: 4, holdIn: 7, exhale: 8 }, // 4-7-8 calming pattern
      spiralSpeed: 0.65,
      fractionationDip: 0.35,
    },
    {
      // Stage 4: One deliberate gate — a conscious choice point.
      // Everything stops, user decides, then sinks into deep.
      name: 'deep',
      duration: 70,
      intensity: 0.95,
      texts: [
        'pure stillness',
        'complete peace',
        'nothing to do',
        'nowhere to be',
        'just this',
        'floating',
        'safe',
      ],
      textInterval: 12,
      breathCycle: 12,
      breathPattern: { inhale: 4, holdIn: 4, exhale: 4, holdOut: 4 }, // box breathing — deep calm
      spiralSpeed: 0.4,
      fractionationDip: 0.55,
      interactions: [
        {
          type: 'gate',
          triggerAt: 0,      // right at the boundary — one pause
          duration: 30,
          data: { text: 'do you want to go deeper?' },
        },
      ],
    },
    {
      name: 'emergence',
      duration: 30,
      intensity: 0.35,
      texts: [
        'gently now\nbeginning to return',
        'carrying this calm\nwith you',
        'feeling refreshed\nand clear',
        'whenever you are ready\nopen your eyes fully',
      ],
      textInterval: 8,
      breathCycle: 8,
      spiralSpeed: 1.0,
    },
  ],
  photoWarning: true,
  contentWarning: null,
};
