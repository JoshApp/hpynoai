/**
 * Transition manager — smooth crossfades between app states.
 *
 * Uses a simple opacity envelope: fade out → switch → fade in.
 * The tunnel keeps running throughout so there's never a blank frame.
 * Intensity ramps down during fade-out and up during fade-in for
 * a "sinking deeper" / "surfacing" feel.
 */

export interface TransitionState {
  /** 0 = fully visible, 1 = fully faded out */
  fadeAmount: number;
  /** True while any transition is in progress */
  active: boolean;
  /** Intensity multiplier (dims during transitions) */
  intensityMult: number;
}

type TransitionPhase = 'idle' | 'fade-out' | 'hold' | 'fade-in';

const FADE_OUT_MS = 1200;
const HOLD_MS = 400;
const FADE_IN_MS = 1500;

export class TransitionManager {
  private phase: TransitionPhase = 'idle';
  private startTime = 0;
  private midCallback: (() => void) | null = null;
  private resolvePromise: (() => void) | null = null;

  // Configurable durations (can be overridden per transition)
  private fadeOutMs = FADE_OUT_MS;
  private holdMs = HOLD_MS;
  private fadeInMs = FADE_IN_MS;

  /** Current state — read every frame by the render loop */
  readonly state: TransitionState = {
    fadeAmount: 0,
    active: false,
    intensityMult: 1,
  };

  /**
   * Run a transition: fade out → call midCallback → fade in.
   * The midCallback is where you switch states (dispose selector, start session, etc.)
   */
  run(midCallback: () => void, opts?: {
    fadeOutMs?: number;
    holdMs?: number;
    fadeInMs?: number;
  }): Promise<void> {
    // If already transitioning, skip
    if (this.phase !== 'idle') return Promise.resolve();

    this.fadeOutMs = opts?.fadeOutMs ?? FADE_OUT_MS;
    this.holdMs = opts?.holdMs ?? HOLD_MS;
    this.fadeInMs = opts?.fadeInMs ?? FADE_IN_MS;
    this.midCallback = midCallback;
    this.phase = 'fade-out';
    this.startTime = performance.now();
    this.state.active = true;

    return new Promise(resolve => {
      this.resolvePromise = resolve;
    });
  }

  /** Call every frame from the animation loop */
  update(): void {
    if (this.phase === 'idle') return;

    const elapsed = performance.now() - this.startTime;

    switch (this.phase) {
      case 'fade-out': {
        const t = Math.min(1, elapsed / this.fadeOutMs);
        // Smooth ease-in (slow start, fast end)
        const ease = t * t;
        this.state.fadeAmount = ease;
        this.state.intensityMult = 1 - ease * 0.7; // dim to 30%
        if (t >= 1) {
          // Fire the mid-transition callback
          if (this.midCallback) {
            this.midCallback();
            this.midCallback = null;
          }
          this.phase = 'hold';
          this.startTime = performance.now();
        }
        break;
      }

      case 'hold': {
        this.state.fadeAmount = 1;
        this.state.intensityMult = 0.3;
        if (elapsed >= this.holdMs) {
          this.phase = 'fade-in';
          this.startTime = performance.now();
        }
        break;
      }

      case 'fade-in': {
        const t = Math.min(1, elapsed / this.fadeInMs);
        // Smooth ease-out (fast start, slow end)
        const ease = 1 - (1 - t) * (1 - t);
        this.state.fadeAmount = 1 - ease;
        this.state.intensityMult = 0.3 + ease * 0.7; // ramp back to 100%
        if (t >= 1) {
          this.state.fadeAmount = 0;
          this.state.intensityMult = 1;
          this.state.active = false;
          this.phase = 'idle';
          if (this.resolvePromise) {
            this.resolvePromise();
            this.resolvePromise = null;
          }
        }
        break;
      }
    }
  }

  /** True if we're in the middle of a transition */
  get isActive(): boolean {
    return this.phase !== 'idle';
  }

  /** Cancel any in-progress transition (for HMR) */
  cancel(): void {
    this.phase = 'idle';
    this.state.fadeAmount = 0;
    this.state.intensityMult = 1;
    this.state.active = false;
    this.midCallback = null;
    if (this.resolvePromise) {
      this.resolvePromise();
      this.resolvePromise = null;
    }
  }
}
