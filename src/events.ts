/**
 * Typed event bus for HPYNO.
 *
 * Lifecycle events only — per-frame data (audio bands, breath value)
 * stays as direct property reads for performance.
 *
 * Usage:
 *   bus.emit('stage:changed', { stage, index, total });
 *   const unsub = bus.on('stage:changed', ({ stage }) => { ... });
 *   unsub(); // cleanup
 */

import type { SessionConfig } from './session';
import type { HpynoSettings } from './settings';

// ── Event map — every event name to its payload type ──────────

export interface HpynoEventMap {
  // Phase lifecycle
  'phase:changed': { from: string; to: string; sessionId?: string };

  // Session lifecycle
  'session:starting': { session: SessionConfig };
  'session:started': { session: SessionConfig };
  'session:ending': { fadeSec?: number };
  'session:ended': {};

  // Narration — text display with optional karaoke word timing
  'narration:line': {
    text: string;
    words?: Array<{ word: string; start: number; end: number }>;
    audioStartTime?: number;
  };

  // Interactions
  'interaction:complete': { type: string };

  // Settings
  'settings:changed': { settings: Readonly<HpynoSettings> };

  // Selector
  'selector:ready': {};

  // Input (semantic actions from InputController)
  'input:confirm': {};                                    // space / tap / enter
  'input:back': {};                                       // escape
  'input:left': {};                                       // arrow left / swipe right
  'input:right': {};                                      // arrow right / swipe left
  'input:hold-start': {};                                 // space down / touch start
  'input:hold-end': {};                                   // space up / touch end
  'input:swipe': { direction: 'left' | 'right' | 'up' | 'down'; dx: number; dy: number };
  'input:pointer-move': { x: number; y: number };         // NDC coords (-1 to 1)
  'input:tap': { x: number; y: number; clientX: number; clientY: number }; // NDC + screen coords

  // Isolation mode
  'isolation:boundary-reached': { boundary: number };

  // Entitlements / content gating
  'entitlement:upgrade-prompt': { feature: string; context?: string };
  'entitlement:changed': {};
}

// ── Bus implementation ────────────────────────────────────────

import { log } from './logger';

type Handler<T> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<string, Set<Handler<unknown>>>();

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof HpynoEventMap>(
    event: K,
    handler: Handler<HpynoEventMap[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const set = this.listeners.get(event)!;
    set.add(handler as Handler<unknown>);
    return () => set.delete(handler as Handler<unknown>);
  }

  /** Subscribe once — auto-unsubscribes after first call. */
  once<K extends keyof HpynoEventMap>(
    event: K,
    handler: Handler<HpynoEventMap[K]>,
  ): () => void {
    const unsub = this.on(event, (payload) => {
      unsub();
      handler(payload);
    });
    return unsub;
  }

  /** Emit an event synchronously to all subscribers. */
  emit<K extends keyof HpynoEventMap>(
    event: K,
    payload: HpynoEventMap[K],
  ): void {
    log.logBusEvent(event, payload);
    const set = this.listeners.get(event);
    if (set) {
      for (const handler of set) {
        try {
          handler(payload);
        } catch (err) {
          log.error('bus', `Handler threw on "${event}"`, err);
        }
      }
    }
  }

  /** Remove all listeners (call on HMR teardown). */
  clear(): void {
    this.listeners.clear();
  }
}
