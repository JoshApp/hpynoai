/**
 * BreathClock — the single breath oscillator for the world.
 * Pattern-driven (inhale / hold / exhale / hold), cosine-eased value,
 * radians phase for shaders. Advanced by dt so it pauses with the player.
 */

import type { BreathInputs, BreathStage } from './types';

export interface BreathPattern {
  inhale: number;
  holdIn: number;
  exhale: number;
  holdOut: number;
}

export const DEFAULT_PATTERN: BreathPattern = { inhale: 4, holdIn: 1, exhale: 5, holdOut: 0 };

export class BreathClock {
  private pattern: BreathPattern = { ...DEFAULT_PATTERN };
  private pending: BreathPattern | null = null;
  private t = 0;
  readonly state: BreathInputs = { value: 0.5, phase: 0, stage: 'inhale' };

  get cycleDuration(): number {
    const p = this.pattern;
    return p.inhale + p.holdIn + p.exhale + p.holdOut;
  }

  /** New pattern takes effect at the next cycle boundary (no jolt). */
  setPattern(p: Partial<BreathPattern>): void {
    this.pending = { ...this.pattern, ...p };
  }

  /** Simple symmetric cycle. */
  setCycle(seconds: number): void {
    this.setPattern({ inhale: seconds / 2, holdIn: 0, exhale: seconds / 2, holdOut: 0 });
  }

  update(dt: number): BreathInputs {
    this.t += dt;
    let cycle = this.cycleDuration;
    if (this.t >= cycle) {
      this.t -= cycle;
      if (this.pending) { this.pattern = this.pending; this.pending = null; cycle = this.cycleDuration; }
      if (this.t >= cycle) this.t = this.t % cycle;
    }
    const p = this.pattern;
    let stage: BreathStage;
    let value: number;
    let local = this.t;
    if (local < p.inhale) {
      stage = 'inhale';
      value = ease(local / p.inhale);
    } else if ((local -= p.inhale) < p.holdIn) {
      stage = 'hold-in';
      value = 1;
    } else if ((local -= p.holdIn) < p.exhale) {
      stage = 'exhale';
      value = 1 - ease(local / p.exhale);
    } else {
      stage = 'hold-out';
      value = 0;
    }
    this.state.value = value;
    this.state.stage = stage;
    this.state.phase = (this.t / cycle) * Math.PI * 2;
    return this.state;
  }
}

function ease(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return 0.5 - 0.5 * Math.cos(c * Math.PI);
}
