// Auto-generated texts from voice manifest — do not edit manually.
// Regenerate with: python3 scripts/generate-session.py scripts/relax.txt
// Session: relax-v2

export const generatedTexts: Record<string, string[]> = {
  'settle': [
    'let\'s begin... by simply breathing... breathe in... when the tunnel expands... breathe out... when it contracts.',
    'good... just like that... keep breathing... nice and slow.',
    'you are watching the screen... and that... is perfectly fine.',
    'notice your breath... moving in... and out... without any effort.',
    'there is nothing you need to do... nowhere you need to be... just here just now',
  ],
  'induction': [
    'and as you watch... you might notice... something interesting...',
    'the more you look... the easier it becomes... to relax',
    'you can feel your body... in the chair... or wherever you are... and that weight... is comfort.',
    'your eyes are open... and each blink... feels a little heavier... a little slower.',
    'that\'s it... just notice... you don\'t need to try... it happens... on its own.',
    'every breath... carries you... a little deeper... a little further... from wherever you were before.',
  ],
  'deepening': [
    'now... let your attention drift... to your shoulders.',
    'notice any tension there... and as you breathe out... let it soften let it go',
    'feel the warmth... spreading down... through your arms... your hands... your fingertips... tingling... softening.',
    'your jaw... unclenching... your forehead... smoothing... every muscle... finding its own rest.',
    'with each exhale... something releases... something you didn\'t even know... you were holding.',
    'heavier now... and that heaviness... is not weight... it\'s permission... permission to stop trying',
    '...',
    'would you like to go deeper?',
    'good... let yourself sink ... a little more.',
  ],
  'trance': [
    'imagine... warmth.',
    'a gentle warmth... surrounding you... like sinking... into something soft.',
    'you might notice... how comfortable this feels... perhaps deeper... than you expected.',
    'and that is perfectly fine... your unconscious mind... knows exactly what to do.',
    'there is nothing... you need to figure out... nothing to solve... nothing to fix. ...',
    'just allow this... to happen like water... finding its level... you find yours.',
    'deeper now without even trying... each breath... taking you further.',
    'the sounds around you... become part of this... everything carries you... deeper',
  ],
  'deep': [
    'pure stillness ...',
    'complete peace ...',
    'nothing to do. ...',
    'nowhere to be. ...',
    'just this. ...',
    'floating. ...',
    'safe. ...',
    'rest here... for as long as you like.',
  ],
  'emergence': [
    'gently now... beginning to return. ...',
    'carrying this calm... with you... like a warm blanket... you can wrap around yourself... anytime. ...',
    'feeling refreshed... and clear... and rested. ...',
    'your body... remembering how to move... slowly... gently... in your own time. ...',
    'whenever you are ready... take a deeper breath... and open your eyes... fully. ...',
    'welcome back.',
  ],
};

// Interaction markers from script (gate, breath-sync, etc.)
export const stageInteractions: Record<string, Array<{ index: number; type: string; text: string }>> = {
  'settle': [
    { index: 0, type: 'breath-sync', text: 'let\'s begin... by simply breathing... breathe in... when the tunnel expands... breathe out... when it contracts.' },
  ],
  'deepening': [
    { index: 7, type: 'gate', text: 'would you like to go deeper?' },
  ],
};

// Stage durations from audio (use these in session config)
export const stageDurations: Record<string, number> = {
  'settle': 53,
  'induction': 67,
  'deepening': 104,
  'trance': 106,
  'deep': 54,
  'emergence': 65,
};

// Interludes — ambient-only silence after each stage (seconds)
export const stageInterludes: Record<string, number> = {
  'settle': 5,
  'induction': 5,
  'deepening': 8,
  'trance': 10,
  'deep': 20,
  'emergence': 15,
};

// Interaction trigger times from audio timestamps
export const stageInteractionTimings: Record<string, Array<{ type: string; triggerAt: number; text: string }>> = {
  'settle': [
    { type: 'breath-sync', triggerAt: 14, text: 'let\'s begin... by simply breathing... breathe in... when the...' },
  ],
  'deepening': [
    { type: 'gate', triggerAt: 90, text: 'would you like to go deeper?...' },
  ],
};
