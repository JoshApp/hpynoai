/**
 * Session persistence — save/restore session progress to localStorage.
 *
 * Periodically saves {sessionId, position, stageIndex, timestamp} during
 * a session. On next boot, checks for saved state and offers resume.
 */

import { log } from './logger';

const STORAGE_KEY = 'hpyno_session_progress';
const SAVE_INTERVAL_MS = 5000; // save every 5 seconds
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // expire after 24 hours

export interface SavedSession {
  sessionId: string;
  position: number;      // timeline position in seconds
  stageIndex: number;
  timestamp: number;     // Date.now() when saved
}

/** Start auto-saving session progress. Returns a stop function. */
export function startAutoSave(
  getState: () => { sessionId: string; position: number; stageIndex: number } | null,
): () => void {
  const interval = setInterval(() => {
    const state = getState();
    if (!state) return;
    saveProgress(state.sessionId, state.position, state.stageIndex);
  }, SAVE_INTERVAL_MS);

  return () => clearInterval(interval);
}

/** Save current progress */
export function saveProgress(sessionId: string, position: number, stageIndex: number): void {
  try {
    const data: SavedSession = { sessionId, position, stageIndex, timestamp: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* storage full or unavailable */ }
}

/** Load saved progress (returns null if none, expired, or invalid) */
export function loadProgress(): SavedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SavedSession;

    // Validate
    if (!data.sessionId || typeof data.position !== 'number') return null;

    // Expire old saves
    if (Date.now() - data.timestamp > MAX_AGE_MS) {
      clearProgress();
      return null;
    }

    // Don't resume if less than 10 seconds in (not worth it)
    if (data.position < 10) {
      clearProgress();
      return null;
    }

    log.info('persistence', `Found saved session: ${data.sessionId} at ${data.position.toFixed(1)}s`);
    return data;
  } catch {
    return null;
  }
}

/** Clear saved progress */
export function clearProgress(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ok */ }
}

/** Format position for display */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
