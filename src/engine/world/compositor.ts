/**
 * Compositor — applies presets to layers, with timed blended transitions.
 *
 * One persistent world; what changes is the preset. A transition lerps
 * from the previous preset to the new one and re-applies the blend to
 * every layer each frame. Layers own their own easing via PropertyChannel,
 * so a snap here still lands softly.
 */

import type { Layer, Preset, WorldInputs, EasingFn } from './types';
import { easings } from './types';

interface ActiveTransition {
  from: Preset;
  to: Preset;
  progress: number;
  duration: number;
  easing: EasingFn;
}

export interface ConfigureOptions {
  /** Seconds. 0 (default) = hand the target to the layers immediately. */
  duration?: number;
  easing?: EasingFn;
  /** Channel speed used once the target is handed over (default 3). */
  settleSpeed?: number;
}

export class Compositor {
  private layers: Layer[] = [];
  private current: Preset = {};
  /** What the layers are actually being driven toward right now (mid-transition blend). */
  private live: Preset = {};
  private transition: ActiveTransition | null = null;

  add(layer: Layer): void {
    this.layers.push(layer);
  }

  get preset(): Preset { return this.current; }

  configure(preset: Preset, opts: ConfigureOptions = {}): void {
    const duration = opts.duration ?? 0;
    const merged = mergePreset(this.current, preset);
    if (duration > 0) {
      this.transition = {
        from: this.transition ? this.live : this.current,
        to: merged,
        progress: 0,
        duration,
        easing: opts.easing ?? easings.smoothstep,
      };
    } else {
      const speed = opts.settleSpeed ?? 3;
      this.transition = null;
      for (const layer of this.layers) layer.applyPreset(merged, speed);
      this.live = merged;
    }
    this.current = merged;
  }

  /** Snap every layer to the current preset instantly (boot, theme swap). */
  snap(): void {
    this.transition = null;
    this.live = this.current;
    for (const layer of this.layers) layer.applyPreset(this.current, 999);
  }

  update(inputs: WorldInputs, dt: number): void {
    const tr = this.transition;
    if (tr) {
      tr.progress += dt / tr.duration;
      if (tr.progress >= 1) {
        for (const layer of this.layers) layer.applyPreset(tr.to, 3);
        this.live = tr.to;
        this.transition = null;
      } else {
        const blended = blendPresets(tr.from, tr.to, tr.easing(tr.progress));
        this.live = blended;
        for (const layer of this.layers) layer.applyPreset(blended, 5);
      }
    }
    for (const layer of this.layers) layer.update(inputs, dt);
  }

  dispose(): void {
    for (const layer of this.layers) layer.dispose?.();
    this.layers = [];
  }
}

// ── Preset math ──

export function mergePreset(base: Preset, over: Preset): Preset {
  return {
    tunnel: { ...base.tunnel, ...over.tunnel },
    feedback: { ...base.feedback, ...over.feedback },
    camera: { ...base.camera, ...over.camera },
    particles: { ...base.particles, ...over.particles },
    fade: { ...base.fade, ...over.fade },
  };
}

export function blendPresets(a: Preset, b: Preset, t: number): Preset {
  return {
    tunnel: blendObj(a.tunnel, b.tunnel, t),
    feedback: blendObj(a.feedback, b.feedback, t),
    camera: blendObj(a.camera, b.camera, t),
    particles: blendObj(a.particles, b.particles, t),
    fade: blendObj(a.fade, b.fade, t),
  };
}

function blendValue(va: unknown, vb: unknown, t: number): unknown {
  if (typeof va === 'number' && typeof vb === 'number') return va + (vb - va) * t;
  if (Array.isArray(va) && Array.isArray(vb) && va.length === vb.length) {
    return va.map((v, i) => blendValue(v, vb[i], t));
  }
  if (va && vb && typeof va === 'object' && typeof vb === 'object') {
    return blendObj(va as Record<string, unknown>, vb as Record<string, unknown>, t);
  }
  if (vb === undefined) return va;
  return t > 0.5 ? vb : va;
}

function blendObj<T extends object>(a: Partial<T> | undefined, b: Partial<T> | undefined, t: number): Partial<T> {
  if (!a && !b) return {};
  if (!a) return b ?? {};
  if (!b) return a;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    out[key] = blendValue(ra[key], rb[key], t);
  }
  return out as Partial<T>;
}
