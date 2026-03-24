/**
 * Telemetry aggregator — collects per-frame state from all subsystems
 * into structured snapshots and maintains a ring buffer for historical queries.
 *
 * Captures at 10fps (every 6th frame at 60fps). Default 30s = 300 entries.
 * Exposed via window.__HYPNO__.telemetry for AI agents and diagnostics.
 */

import type { TimelineState } from './timeline';
import type { AudioBands } from './audio-analyzer';
import type { BreathStage } from './breath';

// ── Snapshot schema ─────────────────────────────────────────────

export interface TelemetrySnapshot {
  timestamp: number;
  frame: number;

  timeline: {
    position: number;
    blockIndex: number;
    blockProgress: number;
    intensity: number;
    paused: boolean;
    complete: boolean;
  };

  breath: {
    value: number;
    stage: string;
    cycleDuration: number;
  } | null;

  audio: {
    energy: number;
    bass: number;
    mid: number;
    high: number;
    isPeak: boolean;
    voicePresence: number;
  } | null;

  narration: {
    isSpeaking: boolean;
    currentText: string;
    lineProgress: number;
    voiceEnergy: number;
  };

  interactions: {
    breathSyncActive: number;
    breathSyncFill: number;
    humSyncActive: number;
    humProgress: number;
  };

  feedback: {
    disabled: boolean;
  };

  render: {
    fps: number;
    dt: number;
  };

  machine: {
    phase: string;
    epoch: number;
  };
}

// ── Capture input — what main.ts passes each frame ──────────────

export interface TelemetryCaptureInput {
  timelineState: TimelineState | null;
  audioBands: AudioBands | null;
  breathValue: number;
  breathStage: BreathStage | null;
  breathCycleDuration: number;
  narration: {
    isSpeaking: boolean;
    currentText: string;
    lineProgress: number;
    voiceEnergy: number;
  };
  interactions: {
    breathSyncActive: number;
    breathSyncFill: number;
    humSyncActive: number;
    humProgress: number;
  };
  feedbackDisabled: boolean;
  dt: number;
  phase: string;
  epoch: number;
  paused: boolean;
}

// ── Ring buffer ─────────────────────────────────────────────────

class RingBuffer<T> {
  private buffer: T[] = [];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }
    this.buffer.push(item);
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  getLast(count: number): T[] {
    const start = Math.max(0, this.buffer.length - count);
    return this.buffer.slice(start);
  }

  getLatest(): T | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
  }

  clear(): void {
    this.buffer = [];
  }

  get length(): number {
    return this.buffer.length;
  }
}

// ── Telemetry aggregator ────────────────────────────────────────

const CAPTURE_INTERVAL = 6; // every 6th frame ≈ 10fps at 60fps
const DEFAULT_HISTORY_SECONDS = 30;
const ENTRIES_PER_SECOND = 10; // ~60fps / 6

export class TelemetryAggregator {
  private ring: RingBuffer<TelemetrySnapshot>;
  private frameCount = 0;

  constructor(historySeconds = DEFAULT_HISTORY_SECONDS) {
    this.ring = new RingBuffer(historySeconds * ENTRIES_PER_SECOND);
  }

  /** Call every frame from animate(). Only stores a snapshot every 6th frame. */
  capture(input: TelemetryCaptureInput): void {
    this.frameCount++;
    if (this.frameCount % CAPTURE_INTERVAL !== 0) return;

    const tls = input.timelineState;
    const snapshot: TelemetrySnapshot = {
      timestamp: Date.now(),
      frame: this.frameCount,

      timeline: tls ? {
        position: tls.position,
        blockIndex: tls.blockIndex,
        blockProgress: tls.blockProgress,
        intensity: tls.intensity,
        paused: input.paused,
        complete: tls.complete,
      } : {
        position: 0,
        blockIndex: 0,
        blockProgress: 0,
        intensity: 0,
        paused: true,
        complete: false,
      },

      breath: input.breathStage ? {
        value: input.breathValue,
        stage: input.breathStage,
        cycleDuration: input.breathCycleDuration,
      } : null,

      audio: input.audioBands ? {
        energy: input.audioBands.energy,
        bass: input.audioBands.bass,
        mid: input.audioBands.mid,
        high: input.audioBands.high,
        isPeak: input.audioBands.isPeak,
        voicePresence: input.audioBands.voicePresence,
      } : null,

      narration: { ...input.narration },

      interactions: { ...input.interactions },

      feedback: {
        disabled: input.feedbackDisabled,
      },

      render: {
        fps: input.dt > 0 ? 1 / input.dt : 0,
        dt: input.dt,
      },

      machine: {
        phase: input.phase,
        epoch: input.epoch,
      },
    };

    this.ring.push(snapshot);
  }

  /** Get the most recent snapshot. */
  getLatest(): TelemetrySnapshot | null {
    return this.ring.getLatest();
  }

  /** Get last N seconds of snapshots (default: all). */
  getHistory(seconds?: number): TelemetrySnapshot[] {
    if (seconds == null) return this.ring.getAll();
    return this.ring.getLast(Math.ceil(seconds * ENTRIES_PER_SECOND));
  }

  /** Get a single subsystem's data from the latest snapshot. */
  getSubsystem<K extends keyof TelemetrySnapshot>(key: K): TelemetrySnapshot[K] | null {
    const latest = this.ring.getLatest();
    return latest ? latest[key] : null;
  }

  /** Reset the buffer (e.g., on session end). */
  reset(): void {
    this.ring.clear();
    this.frameCount = 0;
  }
}
