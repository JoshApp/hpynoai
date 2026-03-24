/**
 * HMR-persistent state — minimal scalars only.
 *
 * On hot reload, main.ts does a FULL teardown (dispose all Three.js objects,
 * audio nodes, DOM elements, listeners) then rebuilds from scratch. Only
 * these lightweight values survive to restore position via timeline.seek().
 *
 * The WebGL renderer and AudioContext are expensive to recreate, so they
 * persist separately on globalThis.
 */

import type * as THREE from 'three';

export interface HotState {
  // Position restoration
  timelinePosition: number;
  isRunning: boolean;
  activeSessionId: string | null;

  // Accumulated visual state (avoid jumps)
  spiralAngle: number;
  renderTime: number;

  // User overrides
  intensityOverride: number | null;
  shaderIntensityScale: number;
}

const KEY = '__HPYNO_HOT_STATE__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[KEY]) {
  g[KEY] = {
    timelinePosition: 0,
    isRunning: false,
    activeSessionId: null,
    spiralAngle: 0,
    renderTime: 0,
    intensityOverride: null,
    shaderIntensityScale: 1,
  } satisfies HotState;
}

export const hotState: HotState = g[KEY] as HotState;

// ── Expensive singletons that survive teardown ──

const RENDERER_KEY = '__HPYNO_RENDERER__';
const AUDIO_CTX_KEY = '__HPYNO_AUDIO_CTX__';

export function getPersistedRenderer(): THREE.WebGLRenderer | null {
  return (g[RENDERER_KEY] as THREE.WebGLRenderer) ?? null;
}

export function persistRenderer(r: THREE.WebGLRenderer): void {
  g[RENDERER_KEY] = r;
}

export function getPersistedAudioContext(): AudioContext | null {
  return (g[AUDIO_CTX_KEY] as AudioContext) ?? null;
}

export function persistAudioContext(ctx: AudioContext): void {
  g[AUDIO_CTX_KEY] = ctx;
}

// ── Module generation — incremented each HMR load to kill stale rAF loops ──

const GEN_KEY = '__HPYNO_GEN__';
if (g[GEN_KEY] === undefined) g[GEN_KEY] = 0;

export function nextGeneration(): number {
  return ++(g[GEN_KEY] as number);
}

export function currentGeneration(): number {
  return g[GEN_KEY] as number;
}

// ── Teardown registry — functions to call before rebuild ──

const TEARDOWN_KEY = '__HPYNO_TEARDOWN__';

export function getTeardownFns(): Array<() => void> {
  if (!g[TEARDOWN_KEY]) g[TEARDOWN_KEY] = [];
  return g[TEARDOWN_KEY] as Array<() => void>;
}

export function onTeardown(fn: () => void): void {
  getTeardownFns().push(fn);
}

export function runTeardown(): void {
  const fns = getTeardownFns();
  for (const fn of fns) {
    try { fn(); } catch { /* ignore errors during teardown */ }
  }
  fns.length = 0;
}
