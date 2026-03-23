/**
 * Experience level system — determines what interactions are active.
 *
 * Levels (each includes everything from previous levels):
 *   listen  — audio + text only, no interactions
 *   watch   — + gates/consent prompts pause for input
 *   breathe — + breath sync tutorial, breathing interactions
 *   immerse — + microphone, voice detection, hum sync
 *
 * Checked per-frame so switching mid-session takes effect immediately.
 */

export type ExperienceLevel = 'listen' | 'watch' | 'breathe' | 'immerse';

const LEVEL_ORDER: ExperienceLevel[] = ['listen', 'watch', 'breathe', 'immerse'];

/** Check if the current level includes a capability */
export function levelIncludes(current: ExperienceLevel, required: ExperienceLevel): boolean {
  return LEVEL_ORDER.indexOf(current) >= LEVEL_ORDER.indexOf(required);
}

/** Map interaction types to the minimum level needed */
export function interactionAllowed(type: string, level: ExperienceLevel): boolean {
  switch (type) {
    case 'gate':
    case 'voice-gate':
      // Gates are consent checkpoints — show at 'watch' and above
      // At 'listen' level, gates are auto-confirmed (skipped)
      return levelIncludes(level, 'watch');

    case 'breath-sync':
      // Breathing guide runs at ALL levels — it's guided narration, not interaction
      // At 'listen'/'watch': voice guides breathing, no sync required
      // At 'breathe'+: adds interactive sync
      return true;

    case 'hum-sync':
    case 'affirm':
      return levelIncludes(level, 'immerse');

    case 'focus-target':
    case 'countdown':
      return levelIncludes(level, 'watch');

    default:
      return levelIncludes(level, 'watch');
  }
}

/** Human-readable labels */
export const LEVEL_LABELS: Record<ExperienceLevel, { name: string; icon: string; desc: string }> = {
  listen: { name: 'listen', icon: '🎧', desc: 'audio and visuals' },
  watch: { name: 'watch', icon: '👁', desc: 'guided with prompts' },
  breathe: { name: 'breathe', icon: '🫁', desc: 'interactive breathing' },
  immerse: { name: 'immerse', icon: '🎤', desc: 'full body and voice' },
};
