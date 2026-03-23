/**
 * Phase state machine for HPYNO.
 *
 * Single source of truth for "where are we in the experience."
 * Replaces scattered isRunning / sessionEpoch / appState.phase.
 *
 * Valid transitions:
 *   boot         → selector
 *   selector     → transitioning    (user picked a session)
 *   transitioning → session          (fade complete, session running)
 *   session      → ending            (session complete or user escape)
 *   ending       → selector          (cleanup done, back to menu)
 *
 * Each transition increments the epoch. Async flows can check
 * machine.guard(epoch) to bail out if a new transition has happened
 * since they started (replaces the sessionEpoch pattern).
 */

import type { EventBus } from './events';
import { appState, setPhase } from './app-state';
import { log } from './logger';
import type { AppPhase } from './app-state';

export type Phase = 'boot' | 'selector' | 'transitioning' | 'session' | 'ending';

// Which transitions are legal
const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  boot: ['selector'],
  selector: ['transitioning'],
  transitioning: ['session', 'selector'], // selector = abort
  session: ['ending'],
  ending: ['selector'],
};

export class StateMachine {
  private _phase: Phase;
  private _epoch = 0;
  private _sessionId: string | null = null;
  private bus: EventBus | null = null;

  constructor(initialPhase: Phase = 'boot') {
    this._phase = initialPhase;
  }

  /** Connect to the event bus (optional — can work standalone). */
  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  get phase(): Phase {
    return this._phase;
  }

  get epoch(): number {
    return this._epoch;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Check if the current phase matches. */
  is(...phases: Phase[]): boolean {
    return phases.includes(this._phase);
  }

  /** True if we're in an active session (transitioning or running). */
  get isSessionActive(): boolean {
    return this._phase === 'transitioning' || this._phase === 'session';
  }

  /**
   * Transition to a new phase. Returns false if the transition is invalid.
   * Increments epoch, syncs appState, and emits phase:changed.
   */
  transition(to: Phase, opts?: { sessionId?: string }): boolean {
    const from = this._phase;

    if (!VALID_TRANSITIONS[from]?.includes(to)) {
      log.warn('state', `Invalid transition: ${from} → ${to}`);
      return false;
    }

    this._phase = to;
    this._epoch++;
    log.info('state', `${from} → ${to}`, { epoch: this._epoch, sessionId: opts?.sessionId });

    if (opts?.sessionId !== undefined) {
      this._sessionId = opts.sessionId;
    }
    if (to === 'selector') {
      this._sessionId = null;
    }

    // Sync with legacy appState (backward compat for devmode etc.)
    const legacyPhase: AppPhase =
      to === 'transitioning' ? 'session' :
      to === 'ending' ? 'ended' :
      to as AppPhase;
    setPhase(legacyPhase);
    appState.sessionId = this._sessionId;

    // Emit event
    this.bus?.emit('phase:changed', { from, to, sessionId: this._sessionId ?? undefined });

    return true;
  }

  /**
   * Guard for async flows. Returns true if the epoch hasn't changed
   * since the caller captured it. Use to bail out of stale callbacks.
   *
   * Usage:
   *   const epoch = machine.epoch;
   *   await someAsyncWork();
   *   if (!machine.guard(epoch)) return; // session changed, bail
   */
  guard(capturedEpoch: number): boolean {
    return this._epoch === capturedEpoch;
  }

  /** Force a phase (for HMR restore). Skips validation. */
  restore(phase: Phase, sessionId: string | null = null): void {
    this._phase = phase;
    this._sessionId = sessionId;
  }
}
