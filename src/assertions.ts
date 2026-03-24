/**
 * Assertion engine for AI agents and test harnesses.
 *
 * Provides typed state checks against a unified state object
 * that merges timeline (from window.__HYPNO__.getState()) and
 * telemetry (from TelemetryAggregator) into a single queryable tree.
 *
 * Usage via Chrome DevTools evaluate_script:
 *   window.__HYPNO__.assert.state('timeline.position', 10, 'gt')
 *   window.__HYPNO__.assert.waitFor('breath.stage', 'exhale', 'eq', 5000)
 *   window.__HYPNO__.assert.batch([
 *     { path: 'timeline.paused', expected: false, op: 'eq' },
 *     { path: 'audio.energy', expected: 0, op: 'gt' },
 *   ])
 */

import type { TelemetryAggregator, TelemetrySnapshot } from './telemetry';
import type { HypnoAPI } from './api';
import type { AudioEngine } from './audio';
import type { NarrationEngine } from './narration';
import type * as THREE from 'three';
import { BaselineManager } from './baseline';
import type { BaselineSnapshot, BaselineComparison, ToleranceConfig } from './baseline';

// ── Types ────────────────────────────────────────────────────────

export type { BaselineSnapshot, BaselineComparison, ToleranceConfig } from './baseline';

export type AssertOp = 'eq' | 'gt' | 'lt' | 'contains' | 'truthy' | 'range';

export interface AssertionCheck {
  path: string;
  expected: unknown;
  op: AssertOp;
}

export interface AssertionResult {
  pass: boolean;
  path: string;
  op: AssertOp;
  expected: unknown;
  actual: unknown;
  message: string;
  telemetrySnapshot?: TelemetrySnapshot | null;
}

export interface AssertionReport {
  total: number;
  passed: number;
  failed: number;
  results: AssertionResult[];
  timestamp: number;
}

// ── Unified state resolution ─────────────────────────────────────

/**
 * Build a flat-accessible unified state object merging timeline API state
 * and the latest telemetry snapshot.
 *
 * Paths:
 *   timeline.position, timeline.blockIndex, timeline.paused, ...
 *   breath.value, breath.stage, breath.cycleDuration
 *   audio.energy, audio.bass, audio.mid, audio.high, audio.isPeak
 *   narration.isSpeaking, narration.currentText, narration.lineProgress
 *   interactions.breathSyncActive, interactions.breathSyncFill, ...
 *   feedback.disabled
 *   render.fps, render.dt
 *   machine.phase, machine.epoch
 */
function buildUnifiedState(
  api: HypnoAPI,
  telemetry: TelemetryAggregator,
): Record<string, unknown> {
  const state: Record<string, unknown> = {};

  // Timeline from API (canonical source)
  const tl = api.getState();
  if (tl) {
    state['timeline.position'] = tl.position;
    state['timeline.blockIndex'] = tl.blockIndex;
    state['timeline.blockProgress'] = tl.blockProgress;
    state['timeline.blockElapsed'] = tl.blockElapsed;
    state['timeline.intensity'] = tl.intensity;
    state['timeline.paused'] = tl.paused;
    state['timeline.complete'] = tl.complete;
    state['timeline.atBoundary'] = tl.atBoundary;
    state['timeline.speed'] = tl.speed;
    state['timeline.currentText'] = tl.currentText;
    if (tl.block) {
      state['timeline.block.kind'] = tl.block.kind;
      state['timeline.block.stageName'] = tl.block.stageName;
      state['timeline.block.start'] = tl.block.start;
      state['timeline.block.end'] = tl.block.end;
      state['timeline.block.duration'] = tl.block.duration;
    }
    if (tl.breath) {
      state['breath.value'] = tl.breath.value;
      state['breath.stage'] = tl.breath.stage;
      state['breath.cycleDuration'] = tl.breath.cycleDuration;
    }
  }

  // Telemetry enrichment (audio, narration, interactions, feedback, render, machine)
  const snap = telemetry.getLatest();
  if (snap) {
    // Only set breath from telemetry if not already set from API
    if (state['breath.value'] === undefined && snap.breath) {
      state['breath.value'] = snap.breath.value;
      state['breath.stage'] = snap.breath.stage;
      state['breath.cycleDuration'] = snap.breath.cycleDuration;
    }

    if (snap.audio) {
      state['audio.energy'] = snap.audio.energy;
      state['audio.bass'] = snap.audio.bass;
      state['audio.mid'] = snap.audio.mid;
      state['audio.high'] = snap.audio.high;
      state['audio.isPeak'] = snap.audio.isPeak;
      state['audio.voicePresence'] = snap.audio.voicePresence;
    }

    state['narration.isSpeaking'] = snap.narration.isSpeaking;
    state['narration.currentText'] = snap.narration.currentText;
    state['narration.lineProgress'] = snap.narration.lineProgress;
    state['narration.voiceEnergy'] = snap.narration.voiceEnergy;

    state['interactions.breathSyncActive'] = snap.interactions.breathSyncActive;
    state['interactions.breathSyncFill'] = snap.interactions.breathSyncFill;
    state['interactions.humSyncActive'] = snap.interactions.humSyncActive;
    state['interactions.humProgress'] = snap.interactions.humProgress;

    state['feedback.disabled'] = snap.feedback.disabled;

    state['render.fps'] = snap.render.fps;
    state['render.dt'] = snap.render.dt;

    state['machine.phase'] = snap.machine.phase;
    state['machine.epoch'] = snap.machine.epoch;
  }

  // Phase from API as fallback
  if (state['machine.phase'] === undefined) {
    state['machine.phase'] = api.getPhase();
  }

  return state;
}

// ── Operators ────────────────────────────────────────────────────

function evaluate(actual: unknown, expected: unknown, op: AssertOp): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'contains':
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    case 'truthy':
      return !!actual;
    case 'range':
      if (typeof actual !== 'number' || !Array.isArray(expected) || expected.length !== 2) {
        return false;
      }
      return actual >= (expected[0] as number) && actual <= (expected[1] as number);
  }
}

function formatMessage(pass: boolean, path: string, op: AssertOp, expected: unknown, actual: unknown): string {
  const verb = pass ? 'PASS' : 'FAIL';
  const expStr = op === 'range' ? `[${(expected as number[]).join(', ')}]` : JSON.stringify(expected);
  return `[${verb}] ${path} ${op} ${expStr} (actual: ${JSON.stringify(actual)})`;
}

// ── Subsystem deps for visual/audio assertions ──────────────────

export interface AssertionSubsystemDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: THREE.WebGLRenderer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tunnelUniforms: Record<string, { value: any }>;
  audio: AudioEngine;
  narration: NarrationEngine;
}

// ── Visual Assertions ────────────────────────────────────────────

class VisualAssertions {
  private results: AssertionResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private renderer: THREE.WebGLRenderer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tunnelUniforms: Record<string, { value: any }>;
  private telemetry: TelemetryAggregator;

  constructor(
    results: AssertionResult[],
    renderer: THREE.WebGLRenderer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tunnelUniforms: Record<string, { value: any }>,
    telemetry: TelemetryAggregator,
  ) {
    this.results = results;
    this.renderer = renderer;
    this.tunnelUniforms = tunnelUniforms;
    this.telemetry = telemetry;
  }

  /** Check that the center of the canvas has brightness above a threshold (0-255). */
  centerBrightness(threshold = 10): AssertionResult {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);

    // Sample a 4x4 patch at center
    const size = 4;
    const pixels = new Uint8Array(size * size * 4);
    gl.readPixels(cx - size / 2, cy - size / 2, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    // Average brightness (luminance approximation)
    let totalBrightness = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      totalBrightness += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
    }
    const avgBrightness = totalBrightness / (size * size);
    const pass = avgBrightness > threshold;

    const result: AssertionResult = {
      pass,
      path: 'visual.centerBrightness',
      op: 'gt',
      expected: threshold,
      actual: Math.round(avgBrightness),
      message: `[${pass ? 'PASS' : 'FAIL'}] visual.centerBrightness gt ${threshold} (actual: ${Math.round(avgBrightness)})`,
      telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
    };
    this.results.push(result);
    return result;
  }

  /** Check that the screen is fully black (fade complete). Threshold is max average brightness. */
  fadeComplete(threshold = 5): AssertionResult {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    // Sample 5 points (center + 4 corners offset inward)
    const points = [
      [Math.floor(w / 2), Math.floor(h / 2)],
      [Math.floor(w * 0.25), Math.floor(h * 0.25)],
      [Math.floor(w * 0.75), Math.floor(h * 0.25)],
      [Math.floor(w * 0.25), Math.floor(h * 0.75)],
      [Math.floor(w * 0.75), Math.floor(h * 0.75)],
    ];

    let maxBrightness = 0;
    const pixel = new Uint8Array(4);
    for (const [x, y] of points) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const brightness = pixel[0] * 0.299 + pixel[1] * 0.587 + pixel[2] * 0.114;
      if (brightness > maxBrightness) maxBrightness = brightness;
    }

    const pass = maxBrightness <= threshold;
    const result: AssertionResult = {
      pass,
      path: 'visual.fadeComplete',
      op: 'lt',
      expected: threshold,
      actual: Math.round(maxBrightness),
      message: `[${pass ? 'PASS' : 'FAIL'}] visual.fadeComplete — max brightness ${Math.round(maxBrightness)} (threshold: ${threshold})`,
      telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
    };
    this.results.push(result);
    return result;
  }

  /** Check a raw shader uniform value. */
  shaderUniform(name: string, expected: unknown, op: AssertOp = 'eq'): AssertionResult {
    const uniform = this.tunnelUniforms[name];
    let actual: unknown = undefined;

    if (uniform) {
      const val = uniform.value;
      // Convert Three.js types to plain values for comparison
      if (val != null && typeof val === 'object' && 'x' in val && 'y' in val) {
        actual = 'z' in val ? { x: val.x, y: val.y, z: val.z } : { x: val.x, y: val.y };
      } else {
        actual = val;
      }
    }

    const pass = evaluate(actual, expected, op);
    const result: AssertionResult = {
      pass,
      path: `visual.uniform.${name}`,
      op,
      expected,
      actual,
      message: formatMessage(pass, `visual.uniform.${name}`, op, expected, actual),
      telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
    };
    this.results.push(result);
    return result;
  }
}

// ── Audio Assertions ─────────────────────────────────────────────

class AudioAssertions {
  private results: AssertionResult[];
  private audio: AudioEngine;
  private narration: NarrationEngine;
  private telemetry: TelemetryAggregator;

  constructor(
    results: AssertionResult[],
    audio: AudioEngine,
    narration: NarrationEngine,
    telemetry: TelemetryAggregator,
  ) {
    this.results = results;
    this.audio = audio;
    this.narration = narration;
    this.telemetry = telemetry;
  }

  /** Check that the binaural beat frequency is within a Hz range. */
  binauralInRange(lowHz: number, highHz: number): AssertionResult {
    const state = this.audio.getBinauralState();
    const beatFreq = state?.beatFreq ?? 0;
    const pass = state != null && state.enabled && beatFreq >= lowHz && beatFreq <= highHz;

    const result: AssertionResult = {
      pass,
      path: 'audio.binauralFreq',
      op: 'range',
      expected: [lowHz, highHz],
      actual: state ? { enabled: state.enabled, beatFreq: Math.round(beatFreq * 100) / 100 } : null,
      message: `[${pass ? 'PASS' : 'FAIL'}] audio.binauralFreq in [${lowHz}, ${highHz}]Hz (actual: ${state ? `${beatFreq.toFixed(2)}Hz, enabled=${state.enabled}` : 'not initialized'})`,
      telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
    };
    this.results.push(result);
    return result;
  }

  /** Check that an audio analyzer band is above a threshold (0-1). */
  bandAbove(band: 'energy' | 'bass' | 'mid' | 'high', threshold: number): AssertionResult {
    const bands = this.audio.analyzer?.update();
    const actual = bands ? bands[band] : 0;
    const pass = actual > threshold;

    const result: AssertionResult = {
      pass,
      path: `audio.${band}`,
      op: 'gt',
      expected: threshold,
      actual: Math.round(actual * 1000) / 1000,
      message: `[${pass ? 'PASS' : 'FAIL'}] audio.${band} gt ${threshold} (actual: ${actual.toFixed(3)})`,
      telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
    };
    this.results.push(result);
    return result;
  }

  /** Check if narration audio is currently playing. */
  narrationPlaying(): AssertionResult {
    const state = this.narration.state;
    const pass = state.isSpeaking;

    const result: AssertionResult = {
      pass,
      path: 'audio.narrationPlaying',
      op: 'truthy',
      expected: true,
      actual: state.isSpeaking,
      message: `[${pass ? 'PASS' : 'FAIL'}] audio.narrationPlaying (isSpeaking: ${state.isSpeaking}, text: "${state.currentText.slice(0, 50)}")`,
      telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
    };
    this.results.push(result);
    return result;
  }
}

// ── Assertion Engine ─────────────────────────────────────────────

export class AssertionEngine {
  private results: AssertionResult[] = [];
  private api: HypnoAPI;
  private telemetry: TelemetryAggregator;
  readonly baseline: BaselineManager;

  /** Visual assertion helpers — available after setSubsystems() */
  visual: VisualAssertions | null = null;
  /** Audio assertion helpers — available after setSubsystems() */
  audio: AudioAssertions | null = null;

  constructor(api: HypnoAPI, telemetry: TelemetryAggregator) {
    this.api = api;
    this.telemetry = telemetry;
    this.baseline = new BaselineManager(api, telemetry);
  }

  /** Wire in subsystem references for visual/audio assertions. */
  setSubsystems(deps: AssertionSubsystemDeps): void {
    this.visual = new VisualAssertions(this.results, deps.renderer, deps.tunnelUniforms, this.telemetry);
    this.audio = new AudioAssertions(this.results, deps.audio, deps.narration, this.telemetry);
  }

  /** Immediate state assertion — checks current value at path. */
  state(path: string, expected: unknown, op: AssertOp = 'eq'): AssertionResult {
    const unified = buildUnifiedState(this.api, this.telemetry);
    const actual = unified[path];
    const pass = evaluate(actual, expected, op);
    const result: AssertionResult = {
      pass,
      path,
      op,
      expected,
      actual,
      message: formatMessage(pass, path, op, expected, actual),
      telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
    };
    this.results.push(result);
    return result;
  }

  /**
   * Temporal assertion — polls until condition is met or timeout.
   * Returns a Promise that resolves with the result.
   * Default timeout: 5000ms, poll interval: 100ms.
   */
  waitFor(
    path: string,
    expected: unknown,
    op: AssertOp = 'eq',
    timeoutMs = 5000,
  ): Promise<AssertionResult> {
    const pollInterval = 100;
    const start = Date.now();

    return new Promise<AssertionResult>((resolve) => {
      const check = () => {
        const unified = buildUnifiedState(this.api, this.telemetry);
        const actual = unified[path];
        const pass = evaluate(actual, expected, op);

        if (pass || Date.now() - start >= timeoutMs) {
          const result: AssertionResult = {
            pass,
            path,
            op,
            expected,
            actual,
            message: pass
              ? formatMessage(true, path, op, expected, actual)
              : `[FAIL] ${path} ${op} ${JSON.stringify(expected)} — timed out after ${timeoutMs}ms (last: ${JSON.stringify(actual)})`,
            telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
          };
          this.results.push(result);
          resolve(result);
          return;
        }

        setTimeout(check, pollInterval);
      };

      check();
    });
  }

  /** Run multiple assertions at once. Returns all results. */
  batch(checks: AssertionCheck[]): AssertionResult[] {
    const unified = buildUnifiedState(this.api, this.telemetry);
    const batchResults: AssertionResult[] = [];

    for (const { path, expected, op } of checks) {
      const actual = unified[path];
      const pass = evaluate(actual, expected, op);
      const result: AssertionResult = {
        pass,
        path,
        op,
        expected,
        actual,
        message: formatMessage(pass, path, op, expected, actual),
        telemetrySnapshot: pass ? undefined : this.telemetry.getLatest(),
      };
      this.results.push(result);
      batchResults.push(result);
    }

    return batchResults;
  }

  /** Get a structured report of all assertions run so far. */
  getReport(): AssertionReport {
    const passed = this.results.filter(r => r.pass).length;
    return {
      total: this.results.length,
      passed,
      failed: this.results.length - passed,
      results: [...this.results],
      timestamp: Date.now(),
    };
  }

  /** Clear all recorded results. */
  clearReport(): void {
    this.results = [];
  }
}
