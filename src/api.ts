/**
 * window.__HYPNO__ — programmatic API for AI agents and test harnesses.
 *
 * Exposes timeline control, state queries, event subscriptions, and
 * a ring-buffer event log for poll-based consumers (Chrome DevTools evaluate_script).
 */

import type { Timeline, TimelineState, TimelineBlock } from './timeline';
import type { StateMachine } from './state-machine';
import type { InteractionManager } from './interactions';
import type { BreathController } from './breath';
import type { NarrationEngine } from './narration';
import type { AudioEngine } from './audio';
import type { TelemetryAggregator } from './telemetry';
import type { EventBus } from './events';
import type { FrameProfiler, FrameBudget } from './frame-profiler';
import { log } from './logger';
import { AssertionEngine } from './assertions';
import type { MicrophoneEngine } from './microphone';

// ── Public types (all JSON-serializable) ────────────────────────

export interface TimelineSnapshot {
  position: number;
  blockIndex: number;
  block: {
    kind: string;
    stageName: string;
    start: number;
    end: number;
    duration: number;
  };
  blockElapsed: number;
  blockProgress: number;
  intensity: number;
  breath: { value: number; stage: string; cycleDuration: number } | null;
  currentText: string | null;
  speed: number;
  paused: boolean;
  complete: boolean;
  atBoundary: boolean;
}

export interface BlockInfo {
  index: number;
  kind: string;
  stageName: string;
  start: number;
  end: number;
  duration: number;
}

export type HypnoEvent =
  | 'block:changed'
  | 'interaction:boundary'
  | 'interaction:complete'
  | 'narration:line'
  | 'session:started'
  | 'session:ended'
  | 'state:update';

export interface EventLogEntry {
  event: string;
  data: unknown;
  timestamp: number;
}

export interface HealthReport {
  healthy: boolean;
  checks: {
    renderer: { ok: boolean; fps: number; lastFrameMs: number };
    audio: { ok: boolean; state: string; hasAnalyzer: boolean };
    timeline: { ok: boolean; started: boolean; paused: boolean; position: number };
    errors: { ok: boolean; count: number; recent: string[] };
  };
  uptime: number;
  sessionId: string | null;
  phase: string;
}

// ── Event log ring buffer ───────────────────────────────────────

const MAX_LOG_ENTRIES = 200;

class EventLog {
  private entries: EventLogEntry[] = [];

  push(event: string, data: unknown): void {
    if (this.entries.length >= MAX_LOG_ENTRIES) {
      this.entries.shift();
    }
    this.entries.push({ event, data, timestamp: Date.now() });
  }

  get(since?: number): EventLogEntry[] {
    if (since == null) return [...this.entries];
    return this.entries.filter(e => e.timestamp > since);
  }

  clear(): void {
    this.entries = [];
  }
}

// ── Factory deps ────────────────────────────────────────────────

export interface HypnoAPIDeps {
  timeline: Timeline;
  machine: StateMachine;
  interactions: InteractionManager;
  breath: BreathController;
  narration: NarrationEngine;
  audio: AudioEngine;
  telemetry: TelemetryAggregator;
  bus: EventBus;
  canvas?: HTMLCanvasElement;
  mic?: MicrophoneEngine;
  profiler?: FrameProfiler;
}

// ── Helpers ─────────────────────────────────────────────────────

function stateToSnapshot(state: TimelineState, timeline: Timeline): TimelineSnapshot {
  const block = state.block;
  const breathPattern = state.breathPattern;
  const cycleDuration = breathPattern
    ? breathPattern.inhale + (breathPattern.holdIn ?? 0) + breathPattern.exhale + (breathPattern.holdOut ?? 0)
    : 0;

  return {
    position: state.position,
    blockIndex: state.blockIndex,
    block: {
      kind: block.kind,
      stageName: block.stage.name,
      start: block.start,
      end: block.end,
      duration: block.duration,
    },
    blockElapsed: state.blockElapsed,
    blockProgress: state.blockProgress,
    intensity: state.intensity,
    breath: state.breathValue != null && state.breathStage != null
      ? { value: state.breathValue, stage: state.breathStage, cycleDuration }
      : null,
    currentText: state.currentText,
    speed: timeline.speed,
    paused: timeline.paused,
    complete: state.complete,
    atBoundary: state.atBoundary,
  };
}

function blockToInfo(block: TimelineBlock, index: number): BlockInfo {
  return {
    index,
    kind: block.kind,
    stageName: block.stage.name,
    start: block.start,
    end: block.end,
    duration: block.duration,
  };
}

// ── Factory ─────────────────────────────────────────────────────

const PAGE_LOAD_TIME = performance.now();

export function createHypnoAPI(deps: HypnoAPIDeps) {
  const { timeline, machine, interactions, audio, telemetry, bus, canvas, mic, profiler } = deps;
  const eventLog = new EventLog();

  // Frame timing for health check
  let lastFrameTs = 0;        // performance.now() of last _onFrame call
  let frameReceived = false;  // true after first _onFrame/_onBackgroundFrame call
  let fpsAccum = 0;           // frames counted in current second
  let fpsValue = 0;           // last computed FPS
  let fpsWindowStart = 0;     // start of current 1s window

  // Event subscribers
  type Callback = (data: unknown) => void;
  const subscribers = new Map<string, Set<Callback>>();

  function emit(event: string, data: unknown): void {
    eventLog.push(event, data);
    const subs = subscribers.get(event);
    if (subs) {
      for (const cb of subs) {
        try { cb(data); } catch { /* swallow */ }
      }
    }
  }

  // Track frame count for state:update throttle (every 6th frame ≈ 10fps at 60fps)
  let frameCount = 0;
  let lastBlockIndex = -1;
  let wasAtBoundary = false;

  const api = {
    // ── Timeline Control ──────────────────────────────────────

    seek(seconds: number): void {
      if (!timeline.started) return;
      timeline.seek(seconds);
    },

    seekBlock(index: number): void {
      const blocks = timeline.allBlocks;
      if (index >= 0 && index < blocks.length) {
        timeline.seek(blocks[index].start);
      }
    },

    seekBlockByType(
      type: 'narration' | 'breathing' | 'interaction' | 'transition',
      direction: 'next' | 'prev' = 'next',
    ): void {
      const blocks = timeline.allBlocks;
      if (blocks.length === 0) return;
      const current = timeline.currentIndex;
      if (direction === 'next') {
        for (let i = current + 1; i < blocks.length; i++) {
          if (blocks[i].kind === type) { timeline.seek(blocks[i].start); return; }
        }
      } else {
        for (let i = current - 1; i >= 0; i--) {
          if (blocks[i].kind === type) { timeline.seek(blocks[i].start); return; }
        }
      }
    },

    seekStage(name: string): void {
      const blocks = timeline.allBlocks;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].stage.name === name) { timeline.seek(blocks[i].start); return; }
      }
    },

    play(): void {
      if (timeline.started && timeline.paused) timeline.resume();
    },

    pause(): void {
      if (timeline.started && !timeline.paused) timeline.pause();
    },

    step(direction: 1 | -1 = 1): void {
      const blocks = timeline.allBlocks;
      const target = timeline.currentIndex + direction;
      if (target >= 0 && target < blocks.length) {
        timeline.seek(blocks[target].start);
      }
    },

    setSpeed(multiplier: number): void {
      timeline.setSpeed(multiplier);
    },

    // ── State Queries ─────────────────────────────────────────

    getState(): TimelineSnapshot | null {
      const state = timeline.lastState;
      if (!state) return null;
      return stateToSnapshot(state, timeline);
    },

    getBlocks(): BlockInfo[] {
      return timeline.allBlocks.map((b, i) => blockToInfo(b, i));
    },

    getStages(): string[] {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const block of timeline.allBlocks) {
        if (!seen.has(block.stage.name)) {
          seen.add(block.stage.name);
          result.push(block.stage.name);
        }
      }
      return result;
    },

    isPlaying(): boolean {
      return timeline.started && !timeline.paused;
    },

    getSessionId(): string | null {
      return machine.sessionId;
    },

    getPhase(): string {
      return machine.phase;
    },

    // ── Interactions ──────────────────────────────────────────

    skipInteraction(): void {
      interactions.skip();
      if (timeline.paused) timeline.resume();
    },

    // ── Event Subscriptions ───────────────────────────────────

    on(event: HypnoEvent, callback: (data: unknown) => void): () => void {
      if (!subscribers.has(event)) {
        subscribers.set(event, new Set());
      }
      const set = subscribers.get(event)!;
      set.add(callback);
      return () => set.delete(callback);
    },

    // ── Event Log Buffer ──────────────────────────────────────

    getEventLog(since?: number): EventLogEntry[] {
      return eventLog.get(since);
    },

    clearEventLog(): void {
      eventLog.clear();
    },

    // ── Health Check ──────────────────────────────────────────

    healthCheck(): HealthReport {
      const now = performance.now();

      // Renderer: is the loop running and keeping up?
      // Before any frame arrives, treat renderer as ok (not yet measurable)
      const lastFrameMs = frameReceived ? now - lastFrameTs : 0;
      const rendererOk = !frameReceived || (lastFrameMs < 500 && fpsValue > 10);

      // Audio: context running and analyzer connected?
      const ctx = audio.context;
      const audioState = ctx?.state ?? 'closed';
      const hasAnalyzer = audio.analyzer != null;
      const audioOk = audioState === 'running' && hasAnalyzer;

      // Timeline: started, no NaN in position?
      const tlState = timeline.lastState;
      const tlStarted = timeline.started;
      const tlPaused = timeline.paused;
      const tlPosition = tlState?.position ?? 0;
      const timelineOk = !tlStarted || (!Number.isNaN(tlPosition) && !Number.isNaN(tlState?.intensity));

      // Errors: recent error/warn count from logger
      const recentErrors = log.errors(5);
      const errorCount = recentErrors.length;
      const errorsOk = recentErrors.filter(e => e.level === 'error').length === 0;

      return {
        healthy: rendererOk && audioOk && timelineOk && errorsOk,
        checks: {
          renderer: { ok: rendererOk, fps: fpsValue, lastFrameMs: Math.round(lastFrameMs) },
          audio: { ok: audioOk, state: audioState, hasAnalyzer },
          timeline: { ok: timelineOk, started: tlStarted, paused: tlPaused, position: tlPosition },
          errors: { ok: errorsOk, count: errorCount, recent: recentErrors.map(e => `[${e.tag}] ${e.msg}`) },
        },
        uptime: Math.round((now - PAGE_LOAD_TIME) / 1000),
        sessionId: machine.sessionId,
        phase: machine.phase,
      };
    },

    // ── Frame Budget Profiler ────────────────────────────────
    /** Get frame budget breakdown: latest frame, 60-frame average, total frames counted. */
    getFrameBudget(): { latest: FrameBudget; avg60: FrameBudget; frames: number } | null {
      return profiler?.getFrameBudget() ?? null;
    },

    // ── Assertions ────────────────────────────────────────────
    // Initialized after api object is created (see below)
    assert: null as unknown as AssertionEngine,

    // ── Input Simulation (for AI agents via Chrome DevTools) ───

    simulate: {
      /** Dispatch a click at viewport coordinates. */
      click(x: number, y: number): void {
        const target = canvas ?? document.querySelector('canvas');
        if (!target) return;
        target.dispatchEvent(new MouseEvent('click', {
          clientX: x, clientY: y, bubbles: true, cancelable: true,
        }));
      },

      /** Dispatch keydown + keyup for the given key code (e.g. "Space", "Enter", "ArrowRight"). */
      key(key: string): void {
        const opts: KeyboardEventInit = { code: key, key, bubbles: true, cancelable: true };
        document.dispatchEvent(new KeyboardEvent('keydown', opts));
        document.dispatchEvent(new KeyboardEvent('keyup', opts));
      },

      /** Simulate breath-in (same as holding Space / touching screen). */
      breathIn(): void {
        if (!machine.is('session', 'transitioning')) return;
        bus.emit('input:hold-start', {});
      },

      /** Simulate breath-out (same as releasing Space / lifting touch). */
      breathOut(): void {
        if (!machine.is('session', 'transitioning')) return;
        bus.emit('input:hold-end', {});
      },

      /** Simulate sustained hum signal for the given duration (default 5000ms). */
      hum(durationMs?: number): void {
        if (!machine.is('session', 'transitioning')) return;
        bus.emit('input:hold-start', {});
        mic?.injectSignal('hum', true);
        const dur = durationMs ?? 5000;
        setTimeout(() => {
          bus.emit('input:hold-end', {});
          mic?.injectSignal('hum', false);
        }, dur);
      },

      /** Confirm / advance past a blocking gate interaction. */
      confirmGate(): void {
        if (!machine.is('session', 'transitioning')) return;
        bus.emit('input:confirm', {});
      },

      /** Select a session in the carousel by ID. No-op if not in selector phase. */
      selectSession(_id: string): void {
        if (!machine.is('selector')) return;
        bus.emit('input:confirm', {});
      },

      /** Dispatch a click on the canvas — unlocks AudioContext on first user gesture. */
      tapAnywhere(): void {
        const target = canvas ?? document.querySelector('canvas');
        if (!target) return;
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('click', {
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          bubbles: true,
          cancelable: true,
        }));
      },
    },

    // ── Internal: called from animate() ───────────────────────

    /** @internal — called every frame from animate loop */
    _onFrame(state: TimelineState): void {
      // Track frame timing for healthCheck
      const now = performance.now();
      lastFrameTs = now;
      frameReceived = true;
      fpsAccum++;
      if (now - fpsWindowStart >= 1000) {
        fpsValue = fpsAccum;
        fpsAccum = 0;
        fpsWindowStart = now;
      }

      frameCount++;

      // block:changed
      if (state.blockIndex !== lastBlockIndex) {
        lastBlockIndex = state.blockIndex;
        emit('block:changed', blockToInfo(state.block, state.blockIndex));
      }

      // interaction:boundary
      if (state.atBoundary && !wasAtBoundary) {
        emit('interaction:boundary', {
          blockIndex: state.blockIndex,
          type: state.block.interaction?.type ?? null,
        });
      }
      wasAtBoundary = state.atBoundary;

      // state:update — throttled to every 6th frame (~10fps at 60fps)
      if (frameCount % 6 === 0) {
        emit('state:update', stateToSnapshot(state, timeline));
      }
    },

    /** @internal — called every frame from background loop (no timeline state) */
    _onBackgroundFrame(): void {
      const now = performance.now();
      lastFrameTs = now;
      frameReceived = true;
      fpsAccum++;
      if (now - fpsWindowStart >= 1000) {
        fpsValue = fpsAccum;
        fpsAccum = 0;
        fpsWindowStart = now;
      }
    },
  };

  // ── Bridge internal bus events to public API events ─────────

  bus.on('interaction:complete', (payload) => {
    emit('interaction:complete', { type: payload.type });
  });

  bus.on('narration:line', (payload) => {
    emit('narration:line', { text: payload.text });
  });

  bus.on('session:started', (payload) => {
    emit('session:started', { sessionId: payload.session.id, name: payload.session.name });
  });

  bus.on('session:ended', () => {
    emit('session:ended', {});
  });

  // Initialize assertion engine (needs api reference, so done post-construction)
  api.assert = new AssertionEngine(api, telemetry);

  return api;
}

export type HypnoAPI = ReturnType<typeof createHypnoAPI>;

// ── Declare on window ───────────────────────────────────────────

declare global {
  interface Window {
    __HYPNO__?: HypnoAPI;
  }
}
