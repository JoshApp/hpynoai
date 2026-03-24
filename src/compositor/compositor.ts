/**
 * Compositor — orchestrates layers and actors in a persistent 3D world.
 *
 * There's ONE world that's always running. What changes is the configuration:
 * which preset drives the layers, which actors are active, what directives
 * actors receive. Transitions smoothly blend between configurations.
 *
 * The compositor doesn't know what specific layers or actors exist.
 * It just calls update() and render() on whatever's registered.
 */

import type {
  Layer, Actor, Config, Preset, WorldInputs, RenderContext,
  ActorDirective, EasingFn,
} from './types';
import { easings } from './types';
import { log } from '../logger';

interface ActiveTransition {
  fromPreset: Preset;
  toPreset: Preset;
  fromActors: ActorDirective[];
  toActors: ActorDirective[];
  progress: number;
  duration: number;
  easing: EasingFn;
}

export class Compositor {
  private layers: Layer[] = [];
  private actors: Actor[] = [];
  private currentConfig: Config = { preset: {}, actors: [] };
  private transition: ActiveTransition | null = null;

  // ── Registration ──

  addLayer(layer: Layer): void {
    this.layers.push(layer);
    this.layers.sort((a, b) => a.renderOrder - b.renderOrder);
    log.info('compositor', `Layer added: ${layer.name} (order ${layer.renderOrder})`);
  }

  addActor(actor: Actor): void {
    this.actors.push(actor);
    this.actors.sort((a, b) => a.renderOrder - b.renderOrder);
    log.info('compositor', `Actor added: ${actor.name} (order ${actor.renderOrder})`);
  }

  getLayer<T extends Layer>(name: string): T | undefined {
    return this.layers.find(l => l.name === name) as T | undefined;
  }

  getActor<T extends Actor>(name: string): T | undefined {
    return this.actors.find(a => a.name === name) as T | undefined;
  }

  // ── Configuration ──

  /**
   * Transition to a new configuration.
   * Layers lerp preset values. Actors receive directives.
   * If no transition opts, changes are instant (one-frame snap).
   */
  configure(
    config: Config,
    opts?: { duration?: number; easing?: EasingFn },
  ): void {
    const duration = opts?.duration ?? 0;

    if (duration > 0) {
      this.transition = {
        fromPreset: { ...this.currentConfig.preset },
        toPreset: config.preset,
        fromActors: this.currentConfig.actors,
        toActors: config.actors,
        progress: 0,
        duration,
        easing: opts?.easing ?? easings.smoothstep,
      };
    } else {
      // Instant — apply preset directly
      for (const layer of this.layers) {
        layer.applyPreset(config.preset, 999); // high speed = instant
      }
    }

    // Actor directives are always applied immediately
    // (actors handle their own internal transitions)
    for (const directive of config.actors) {
      const actor = this.actors.find(a => a.name === directive.type);
      if (actor) {
        if (!actor.active) actor.activate(directive);
        else actor.setDirective(directive);
      }
    }

    this.currentConfig = config;
  }

  // ── Update (called every tick, always runs) ──

  update(inputs: WorldInputs, dt: number): void {
    // Advance transition
    if (this.transition) {
      this.transition.progress += dt / this.transition.duration;
      if (this.transition.progress >= 1) {
        this.transition.progress = 1;
        // Apply final preset at normal speed
        for (const layer of this.layers) {
          layer.applyPreset(this.transition.toPreset, 3);
        }
        this.transition = null;
      } else {
        // Blend presets and apply with transition speed
        const t = this.transition.easing(this.transition.progress);
        const blended = blendPresets(this.transition.fromPreset, this.transition.toPreset, t);
        for (const layer of this.layers) {
          layer.applyPreset(blended, 5); // fast speed during transition
        }
      }
    }

    // Update all layers
    for (const layer of this.layers) {
      layer.update(inputs, dt);
    }

    // Update active actors
    for (const actor of this.actors) {
      if (actor.active) actor.update(inputs, dt);
    }
  }

  // ── Render (called per visible frame) ──

  render(ctx: RenderContext): void {
    // Layers render in order
    for (const layer of this.layers) {
      layer.render?.(ctx);
    }
    // Actors render in order
    for (const actor of this.actors) {
      if (actor.active) actor.render?.(ctx);
    }
  }

  // ── Lifecycle ──

  onSessionStart(session: import('../session').SessionConfig): void {
    for (const layer of this.layers) layer.onSessionStart?.(session);
    for (const actor of this.actors) actor.onSessionStart?.(session);
  }

  onSessionEnd(): void {
    for (const layer of this.layers) layer.onSessionEnd?.();
    for (const actor of this.actors) actor.onSessionEnd?.();
  }

  dispose(): void {
    for (const layer of this.layers) layer.dispose?.();
    for (const actor of this.actors) actor.dispose?.();
    this.layers = [];
    this.actors = [];
  }
}

// ── Preset blending ──

function blendPresets(a: Preset, b: Preset, t: number): Preset {
  return {
    tunnel: blendObj(a.tunnel, b.tunnel, t),
    feedback: blendObj(a.feedback, b.feedback, t),
    camera: blendObj(a.camera, b.camera, t),
    particles: blendObj(a.particles, b.particles, t),
    fade: blendObj(a.fade, b.fade, t),
  };
}

function blendObj<T extends Record<string, unknown>>(
  a: Partial<T> | undefined,
  b: Partial<T> | undefined,
  t: number,
): Partial<T> {
  if (!a && !b) return {};
  if (!a) return b ?? {};
  if (!b) return a;

  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of keys) {
    const va = (a as Record<string, unknown>)[key];
    const vb = (b as Record<string, unknown>)[key];

    if (typeof va === 'number' && typeof vb === 'number') {
      result[key] = va + (vb - va) * t;
    } else if (typeof vb === 'boolean') {
      result[key] = t > 0.5 ? vb : va;
    } else if (Array.isArray(va) && Array.isArray(vb) && va.length === vb.length) {
      // Blend arrays (e.g., color tuples)
      result[key] = va.map((v: number, i: number) => v + ((vb[i] as number) - v) * t);
    } else if (vb !== undefined) {
      // Non-blendable: snap at midpoint
      result[key] = t > 0.5 ? vb : va;
    } else {
      result[key] = va;
    }
  }

  return result as Partial<T>;
}
