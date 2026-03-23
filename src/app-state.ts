/**
 * Application state machine — tracks where the user is in the experience.
 *
 * Survives HMR via globalThis so hot reloads restore to the exact spot
 * instead of replaying the selector cinematic.
 *
 * States:
 *   boot     → initial load, nothing running yet
 *   selector → session selector is showing (cinematic or orbs)
 *   session  → a session is actively running
 *   ended    → session finished, "welcome back" screen
 */

export type AppPhase = 'boot' | 'selector' | 'session' | 'ended';

export interface AppState {
  phase: AppPhase;
  /** Which session id is active (null if selector/boot) */
  sessionId: string | null;
  /** Current stage index within the active session */
  stageIndex: number;
  /** Whether the selector cinematic has completed (orbs are showing) */
  selectorReady: boolean;
  /** Timestamp of last phase change (performance.now) */
  lastTransition: number;
}

const KEY = '__HPYNO_APP_STATE__';
const g = globalThis as unknown as Record<string, AppState>;

if (!g[KEY]) {
  g[KEY] = {
    phase: 'boot',
    sessionId: null,
    stageIndex: 0,
    selectorReady: false,
    lastTransition: 0,
  };
}

export const appState: AppState = g[KEY];

export function setPhase(phase: AppPhase): void {
  appState.phase = phase;
  appState.lastTransition = performance.now();
}

export function setSessionInfo(sessionId: string, stageIndex: number): void {
  appState.sessionId = sessionId;
  appState.stageIndex = stageIndex;
}

export function clearSession(): void {
  appState.sessionId = null;
  appState.stageIndex = 0;
}
