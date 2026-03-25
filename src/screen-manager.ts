/**
 * ScreenManager — navigation stack for the app.
 *
 * push/pop/replace/reset with transitions. The persistent world
 * (tunnel, presence, audio) keeps running — only the UI layer changes.
 *
 * All transitions go through TransitionManager (fade-out → swap → fade-in).
 * Screens subscribe to bus input events in enter(), unsubscribe in exit().
 */

import type { Screen, ScreenContext } from './screen';
import type { TransitionManager } from './transition';
import type { WorldInputs } from './compositor/types';
import { log } from './logger';

export class ScreenManager {
  private stack: Screen[] = [];
  private ctx: ScreenContext;
  private transition: TransitionManager;
  private _transitioning = false;

  constructor(ctx: ScreenContext, transition: TransitionManager) {
    this.ctx = ctx;
    this.transition = transition;
    // Wire the circular reference
    this.ctx.screenManager = this;
  }

  /** Currently active screen (top of stack) */
  get current(): Screen | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
  }

  /** Stack names for debugging */
  get stackNames(): string[] {
    return this.stack.map(s => s.name);
  }

  get isTransitioning(): boolean {
    return this._transitioning;
  }

  /**
   * Push a new screen on top. Current screen is exited, preserved on stack.
   */
  async push(screen: Screen, opts?: TransitionOpts): Promise<void> {
    if (this._transitioning) return;
    this._transitioning = true;
    const from = this.current;
    log.info('screen', `push: ${from?.name ?? '(none)'} → ${screen.name}`);

    if (opts?.fadeOutMs || opts?.holdMs || opts?.fadeInMs) {
      await this.transition.run(() => {
        from?.exit();
        this.stack.push(screen);
        screen.enter(this.ctx, from?.name ?? null);
        this.applyAudioPreset(screen);
      }, opts);
    } else {
      from?.exit();
      this.stack.push(screen);
      screen.enter(this.ctx, from?.name ?? null);
      this.applyAudioPreset(screen);
    }
    this._transitioning = false;
  }

  /**
   * Replace the top screen. No stack growth (forward navigation).
   */
  async replace(screen: Screen, opts?: TransitionOpts): Promise<void> {
    if (this._transitioning) return;
    this._transitioning = true;
    const from = this.current;
    log.info('screen', `replace: ${from?.name ?? '(none)'} → ${screen.name}`);

    const doSwap = () => {
      from?.exit();
      if (this.stack.length > 0) {
        this.stack[this.stack.length - 1] = screen;
      } else {
        this.stack.push(screen);
      }
      screen.enter(this.ctx, from?.name ?? null);
      this.applyAudioPreset(screen);
    };

    if (opts?.fadeOutMs || opts?.holdMs || opts?.fadeInMs) {
      await this.transition.run(doSwap, opts);
    } else {
      doSwap();
    }
    this._transitioning = false;
  }

  /**
   * Pop the top screen, re-enter the one beneath.
   * Returns false if can't pop (stack has ≤1 screen).
   */
  async pop(opts?: TransitionOpts): Promise<boolean> {
    if (this._transitioning || this.stack.length <= 1) return false;
    this._transitioning = true;
    const from = this.current!;
    log.info('screen', `pop: ${from.name} → ${this.stack[this.stack.length - 2]?.name}`);

    const doSwap = () => {
      from.exit();
      this.stack.pop();
      const revealed = this.current!;
      revealed.enter(this.ctx, from.name);
      this.applyAudioPreset(revealed);
    };

    if (opts?.fadeOutMs || opts?.holdMs || opts?.fadeInMs) {
      await this.transition.run(doSwap, opts);
    } else {
      doSwap();
    }
    this._transitioning = false;
    return true;
  }

  /**
   * Clear entire stack, enter a fresh screen.
   * Used for hard resets (session end → selector).
   */
  async reset(screen: Screen, opts?: TransitionOpts): Promise<void> {
    if (this._transitioning) return;
    this._transitioning = true;
    log.info('screen', `reset: [${this.stackNames.join(', ')}] → ${screen.name}`);

    const doSwap = () => {
      for (let i = this.stack.length - 1; i >= 0; i--) {
        this.stack[i].exit();
      }
      this.stack = [screen];
      screen.enter(this.ctx, null);
      this.applyAudioPreset(screen);
    };

    if (opts?.fadeOutMs || opts?.holdMs || opts?.fadeInMs) {
      await this.transition.run(doSwap, opts);
    } else {
      doSwap();
    }
    this._transitioning = false;
  }

  /** Instant enter without transition (for boot / HMR) */
  enterImmediate(screen: Screen): void {
    this.stack.push(screen);
    screen.enter(this.ctx, null);
    this.applyAudioPreset(screen);
    log.info('screen', `enterImmediate: ${screen.name}`);
  }

  /** Delegate tick to current screen */
  tick(inputs: WorldInputs, dt: number): void {
    this.current?.tick?.(inputs, dt);
  }

  /** Delegate render to current screen */
  render(time: number, dt: number): void {
    this.current?.render?.(time, dt);
  }

  /** Dispose all screens (HMR teardown) */
  dispose(): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      this.stack[i].exit();
    }
    this.stack = [];
  }

  private applyAudioPreset(screen: Screen): void {
    const preset = screen.getAudioPreset?.();
    if (preset) {
      this.ctx.audioCompositor.applyPreset(preset, 2);
    }
  }
}

interface TransitionOpts {
  fadeOutMs?: number;
  holdMs?: number;
  fadeInMs?: number;
}
