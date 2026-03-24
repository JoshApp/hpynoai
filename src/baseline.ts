/**
 * Regression baseline snapshots for assertion comparison.
 *
 * Captures known-good state snapshots per block/stage and stores them
 * in localStorage. Comparison returns structural diffs with configurable
 * per-field tolerance for numeric values.
 *
 * Usage via Chrome DevTools evaluate_script:
 *   window.__HYPNO__.assert.baseline.capture('intro-block-0')
 *   window.__HYPNO__.assert.baseline.compare('intro-block-0')
 *   window.__HYPNO__.assert.baseline.list()
 *   window.__HYPNO__.assert.baseline.remove('intro-block-0')
 */

import type { TelemetrySnapshot, TelemetryAggregator } from './telemetry';
import type { HypnoAPI } from './api';

// ── Types ────────────────────────────────────────────────────────

export interface BaselineSnapshot {
  label: string;
  timestamp: number;
  telemetry: TelemetrySnapshot;
  block: {
    index: number;
    kind: string;
    stageName: string;
    start: number;
    end: number;
    duration: number;
  } | null;
  phase: string;
  sessionId: string | null;
}

export interface FieldDeviation {
  path: string;
  baseline: unknown;
  current: unknown;
  /** Absolute numeric difference, or null for non-numeric fields */
  delta: number | null;
  /** Whether the deviation exceeds the configured tolerance */
  exceeded: boolean;
}

export interface BaselineComparison {
  label: string;
  match: boolean;
  deviations: FieldDeviation[];
  added: string[];
  removed: string[];
  baselineTimestamp: number;
  comparedAt: number;
}

export interface ToleranceConfig {
  [path: string]: number;
}

// ── Default tolerances ───────────────────────────────────────────

const DEFAULT_TOLERANCES: ToleranceConfig = {
  'timeline.position': 0.5,
  'timeline.blockProgress': 0.05,
  'timeline.blockElapsed': 0.5,
  'timeline.intensity': 0.05,
  'breath.value': 0.1,
  'breath.cycleDuration': 0.5,
  'audio.energy': 0.1,
  'audio.bass': 0.1,
  'audio.mid': 0.1,
  'audio.high': 0.1,
  'audio.voicePresence': 0.1,
  'narration.lineProgress': 0.1,
  'narration.voiceEnergy': 0.1,
  'interactions.breathSyncFill': 0.1,
  'interactions.humProgress': 0.1,
  'render.fps': 10,
  'render.dt': 0.02,
  'machine.epoch': Infinity, // always ignore epoch changes
};

// ── Storage key prefix ───────────────────────────────────────────

const STORAGE_PREFIX = 'hypno:baseline:';

// ── Flatten a telemetry snapshot into a dot-path record ──────────

function flattenSnapshot(snap: TelemetrySnapshot): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  flat['timeline.position'] = snap.timeline.position;
  flat['timeline.blockIndex'] = snap.timeline.blockIndex;
  flat['timeline.blockProgress'] = snap.timeline.blockProgress;
  flat['timeline.intensity'] = snap.timeline.intensity;
  flat['timeline.paused'] = snap.timeline.paused;
  flat['timeline.complete'] = snap.timeline.complete;

  if (snap.breath) {
    flat['breath.value'] = snap.breath.value;
    flat['breath.stage'] = snap.breath.stage;
    flat['breath.cycleDuration'] = snap.breath.cycleDuration;
  }

  if (snap.audio) {
    flat['audio.energy'] = snap.audio.energy;
    flat['audio.bass'] = snap.audio.bass;
    flat['audio.mid'] = snap.audio.mid;
    flat['audio.high'] = snap.audio.high;
    flat['audio.isPeak'] = snap.audio.isPeak;
    flat['audio.voicePresence'] = snap.audio.voicePresence;
  }

  flat['narration.isSpeaking'] = snap.narration.isSpeaking;
  flat['narration.currentText'] = snap.narration.currentText;
  flat['narration.lineProgress'] = snap.narration.lineProgress;
  flat['narration.voiceEnergy'] = snap.narration.voiceEnergy;

  flat['interactions.breathSyncActive'] = snap.interactions.breathSyncActive;
  flat['interactions.breathSyncFill'] = snap.interactions.breathSyncFill;
  flat['interactions.humSyncActive'] = snap.interactions.humSyncActive;
  flat['interactions.humProgress'] = snap.interactions.humProgress;

  flat['feedback.disabled'] = snap.feedback.disabled;

  flat['render.fps'] = snap.render.fps;
  flat['render.dt'] = snap.render.dt;

  flat['machine.phase'] = snap.machine.phase;
  flat['machine.epoch'] = snap.machine.epoch;

  return flat;
}

// ── Baseline Manager ─────────────────────────────────────────────

export class BaselineManager {
  private api: HypnoAPI;
  private telemetry: TelemetryAggregator;
  private tolerances: ToleranceConfig;

  constructor(api: HypnoAPI, telemetry: TelemetryAggregator, tolerances?: ToleranceConfig) {
    this.api = api;
    this.telemetry = telemetry;
    this.tolerances = { ...DEFAULT_TOLERANCES, ...tolerances };
  }

  /**
   * Capture the current state as a named baseline.
   * Saves telemetry snapshot + block metadata to localStorage.
   */
  capture(label: string): BaselineSnapshot | null {
    const snap = this.telemetry.getLatest();
    if (!snap) return null;

    const apiState = this.api.getState();

    const baseline: BaselineSnapshot = {
      label,
      timestamp: Date.now(),
      telemetry: snap,
      block: apiState ? {
        index: apiState.blockIndex,
        kind: apiState.block.kind,
        stageName: apiState.block.stageName,
        start: apiState.block.start,
        end: apiState.block.end,
        duration: apiState.block.duration,
      } : null,
      phase: this.api.getPhase(),
      sessionId: this.api.getSessionId(),
    };

    try {
      localStorage.setItem(STORAGE_PREFIX + label, JSON.stringify(baseline));
    } catch {
      // Storage full or unavailable — return snapshot but don't persist
    }

    return baseline;
  }

  /**
   * Compare current state against a previously saved baseline.
   * Returns a structured diff with per-field deviations.
   */
  compare(label: string): BaselineComparison | null {
    const stored = this.load(label);
    if (!stored) return null;

    const currentSnap = this.telemetry.getLatest();
    if (!currentSnap) return null;

    const baseFlat = flattenSnapshot(stored.telemetry);
    const currFlat = flattenSnapshot(currentSnap);

    const allKeys = new Set([...Object.keys(baseFlat), ...Object.keys(currFlat)]);
    const deviations: FieldDeviation[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    for (const path of allKeys) {
      const inBase = path in baseFlat;
      const inCurr = path in currFlat;

      if (!inBase && inCurr) {
        added.push(path);
        continue;
      }
      if (inBase && !inCurr) {
        removed.push(path);
        continue;
      }

      const baseVal = baseFlat[path];
      const currVal = currFlat[path];

      // Skip timestamp/frame — always different
      if (path === 'timestamp' || path === 'frame') continue;

      if (typeof baseVal === 'number' && typeof currVal === 'number') {
        const delta = Math.abs(currVal - baseVal);
        const tolerance = this.tolerances[path] ?? 0;
        const exceeded = delta > tolerance;
        if (exceeded) {
          deviations.push({ path, baseline: baseVal, current: currVal, delta, exceeded });
        }
      } else if (baseVal !== currVal) {
        deviations.push({ path, baseline: baseVal, current: currVal, delta: null, exceeded: true });
      }
    }

    const match = deviations.length === 0 && added.length === 0 && removed.length === 0;

    return {
      label,
      match,
      deviations,
      added,
      removed,
      baselineTimestamp: stored.timestamp,
      comparedAt: Date.now(),
    };
  }

  /** Load a saved baseline by label. */
  load(label: string): BaselineSnapshot | null {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + label);
      if (!raw) return null;
      return JSON.parse(raw) as BaselineSnapshot;
    } catch {
      return null;
    }
  }

  /** List all saved baseline labels. */
  list(): string[] {
    const labels: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) {
        labels.push(key.slice(STORAGE_PREFIX.length));
      }
    }
    return labels.sort();
  }

  /** Remove a saved baseline. */
  remove(label: string): boolean {
    const key = STORAGE_PREFIX + label;
    if (localStorage.getItem(key) === null) return false;
    localStorage.removeItem(key);
    return true;
  }

  /** Remove all saved baselines. */
  clear(): number {
    const labels = this.list();
    for (const label of labels) {
      localStorage.removeItem(STORAGE_PREFIX + label);
    }
    return labels.length;
  }

  /** Update tolerance config at runtime. */
  setTolerance(path: string, value: number): void {
    this.tolerances[path] = value;
  }

  /** Get current tolerance config. */
  getTolerances(): ToleranceConfig {
    return { ...this.tolerances };
  }
}
