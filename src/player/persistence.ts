/** Session progress persistence (localStorage). */

const KEY = 'hpyno.progress.v2';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_POSITION = 10;

export interface SavedProgress {
  sessionId: string;
  position: number;
  mode: 'watch' | 'listen';
  savedAt: number;
}

export function saveProgress(p: Omit<SavedProgress, 'savedAt'>): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...p, savedAt: Date.now() })); } catch { /* unavailable */ }
}

export function loadProgress(): SavedProgress | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedProgress>;
    if (typeof d.sessionId !== 'string' || typeof d.position !== 'number' || typeof d.savedAt !== 'number') return null;
    if (Date.now() - d.savedAt > MAX_AGE_MS || d.position < MIN_POSITION) { clearProgress(); return null; }
    return { sessionId: d.sessionId, position: d.position, mode: d.mode === 'listen' ? 'listen' : 'watch', savedAt: d.savedAt };
  } catch { return null; }
}

export function clearProgress(): void {
  try { localStorage.removeItem(KEY); } catch { /* ok */ }
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
