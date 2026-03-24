/**
 * Structured console protocol for AI agents.
 *
 * Emits [HYPNO:<category>] JSON messages to console.log, parseable by
 * Chrome DevTools MCP list_console_messages. Categories:
 *
 *   [HYPNO:event]  — lifecycle events (block change, interaction, narration, session)
 *   [HYPNO:state]  — periodic state snapshots (~2fps)
 *   [HYPNO:health] — system health (fps, phase, subsystem status)
 *   [HYPNO:error]  — error conditions
 *
 * Subscribes to window.__HYPNO__ events and telemetry.
 * Call initConsoleProtocol() once after the API is mounted on window.
 */

import type { HypnoAPI, HypnoEvent, TimelineSnapshot } from './api';
import type { TelemetryAggregator, TelemetrySnapshot } from './telemetry';

// ── Types ────────────────────────────────────────────────────────────

type ProtocolCategory = 'event' | 'state' | 'health' | 'error';

interface ProtocolMessage {
  category: ProtocolCategory;
  type: string;
  ts: number;
  data: unknown;
}

// ── Emit helper ──────────────────────────────────────────────────────

function emit(category: ProtocolCategory, type: string, data: unknown): void {
  const msg: ProtocolMessage = {
    category,
    type,
    ts: Date.now(),
    data,
  };
  try {
    console.log(`[HYPNO:${category}]`, JSON.stringify(msg));
  } catch (err) {
    // Serialization failed (circular ref, huge object, etc.) — emit error instead
    // Use a plain object to avoid re-triggering the same failure
    const fallback = {
      category: 'error' as const,
      type: 'serialization_failure',
      ts: Date.now(),
      data: {
        originalCategory: category,
        originalType: type,
        error: err instanceof Error ? err.message : String(err),
      },
    };
    console.log('[HYPNO:error]', JSON.stringify(fallback));
  }
}

// ── Unsubscribe tracking ─────────────────────────────────────────────

let unsubs: (() => void)[] = [];
let healthInterval: ReturnType<typeof setInterval> | null = null;

// ── Init ─────────────────────────────────────────────────────────────

export function initConsoleProtocol(
  api: HypnoAPI,
  telemetry?: TelemetryAggregator,
): void {
  // Tear down previous subscriptions (HMR)
  teardownConsoleProtocol();

  // ── Event subscriptions ────────────────────────────────────────

  const events: Array<{ event: HypnoEvent; type: string }> = [
    { event: 'block:changed', type: 'block_changed' },
    { event: 'interaction:boundary', type: 'interaction_boundary' },
    { event: 'interaction:complete', type: 'interaction_complete' },
    { event: 'narration:line', type: 'narration_line' },
    { event: 'session:started', type: 'session_started' },
    { event: 'session:ended', type: 'session_ended' },
  ];

  for (const { event, type } of events) {
    const unsub = api.on(event, (data) => {
      emit('event', type, data);
    });
    unsubs.push(unsub);
  }

  // ── State updates (throttled — every 30th frame of state:update ≈ ~2fps) ──

  let stateCounter = 0;
  const STATE_THROTTLE = 5; // state:update fires ~10fps, emit every 5th = ~2fps

  const unsubState = api.on('state:update', (data) => {
    stateCounter++;
    if (stateCounter % STATE_THROTTLE !== 0) return;
    const snapshot = data as TimelineSnapshot;
    emit('state', 'snapshot', {
      position: snapshot.position,
      blockIndex: snapshot.blockIndex,
      blockKind: snapshot.block.kind,
      stageName: snapshot.block.stageName,
      blockProgress: Math.round(snapshot.blockProgress * 1000) / 1000,
      intensity: Math.round(snapshot.intensity * 1000) / 1000,
      breath: snapshot.breath
        ? { value: Math.round(snapshot.breath.value * 100) / 100, stage: snapshot.breath.stage }
        : null,
      paused: snapshot.paused,
      speed: snapshot.speed,
    });
  });
  unsubs.push(unsubState);

  // ── Health beacon (every 5s) ──────────────────────────────────

  healthInterval = setInterval(() => {
    const state = api.getState();
    const latest = telemetry?.getLatest() ?? null;

    const health: Record<string, unknown> = {
      phase: api.getPhase(),
      playing: api.isPlaying(),
      sessionId: api.getSessionId(),
    };

    if (state) {
      health.position = state.position;
      health.blockIndex = state.blockIndex;
      health.complete = state.complete;
    }

    if (latest) {
      health.fps = Math.round(latest.render.fps);
      health.audioConnected = latest.audio !== null;
      health.feedbackDisabled = latest.feedback.disabled;
      health.narrationSpeaking = latest.narration.isSpeaking;
    }

    emit('health', 'beacon', health);
  }, 5000);

  // Emit initial health beacon immediately
  emit('health', 'init', {
    phase: api.getPhase(),
    playing: api.isPlaying(),
    sessionId: api.getSessionId(),
    blockCount: api.getBlocks().length,
    stages: api.getStages(),
  });
}

// ── Error reporting ──────────────────────────────────────────────────

export function emitProtocolError(source: string, message: string, detail?: unknown): void {
  emit('error', source, { message, detail: detail ?? null });
}

// ── Teardown ─────────────────────────────────────────────────────────

export function teardownConsoleProtocol(): void {
  for (const unsub of unsubs) {
    try { unsub(); } catch { /* ignore */ }
  }
  unsubs = [];
  if (healthInterval !== null) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}
