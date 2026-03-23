/**
 * Centralized breath controller.
 * Drives tunnel shader, text pulse, interactions — everything syncs to this.
 *
 * Supports configurable inhale/hold/exhale/hold pattern (box breathing etc.)
 * Outputs a single phase value (radians) and a normalized 0-1 breath value.
 */

export interface BreathPattern {
  inhale: number;   // seconds
  holdIn: number;   // seconds (hold after inhale)
  exhale: number;   // seconds
  holdOut: number;  // seconds (hold after exhale)
}

export type BreathStage = 'inhale' | 'hold-in' | 'exhale' | 'hold-out';

const DEFAULT_PATTERN: BreathPattern = {
  inhale: 4,
  holdIn: 0,
  exhale: 4,
  holdOut: 0,
};

export class BreathController {
  private _pattern: BreathPattern = { ...DEFAULT_PATTERN };
  private elapsed = 0;
  private lastTime = 0;
  private _value = 0;       // 0-1: 0 = fully exhaled, 1 = fully inhaled
  private _phase = 0;       // radians (for shader compatibility)
  private _stage: BreathStage = 'inhale';
  private _cycleProgress = 0; // 0-1 through full cycle
  private started = false;

  /** Current breath pattern */
  get pattern(): Readonly<BreathPattern> {
    return this._pattern;
  }

  /** Total cycle duration in seconds */
  get cycleDuration(): number {
    return this._pattern.inhale + this._pattern.holdIn + this._pattern.exhale + this._pattern.holdOut;
  }

  /** Current breath value: 0 = exhaled, 1 = inhaled */
  get value(): number {
    return this._value;
  }

  /** Phase in radians — compatible with shader uBreathePhase */
  get phase(): number {
    return this._phase;
  }

  /** Which part of the breath cycle we're in */
  get stage(): BreathStage {
    return this._stage;
  }

  /** 0-1 progress through the full cycle */
  get cycleProgress(): number {
    return this._cycleProgress;
  }

  /** Set a new breath pattern — resets cycle to start from inhale */
  setPattern(pattern: Partial<BreathPattern>): void {
    const newPattern = { ...this._pattern, ...pattern };
    // Only reset if pattern actually changed
    if (newPattern.inhale !== this._pattern.inhale ||
        newPattern.holdIn !== this._pattern.holdIn ||
        newPattern.exhale !== this._pattern.exhale ||
        newPattern.holdOut !== this._pattern.holdOut) {
      this._pattern = newPattern;
      this.elapsed = 0; // restart from inhale
    }
  }

  /** Set pattern from a simple cycle duration (equal inhale/exhale, no holds) */
  setSimpleCycle(durationSeconds: number): void {
    const half = durationSeconds / 2;
    const newPattern = { inhale: half, holdIn: 0, exhale: half, holdOut: 0 };
    if (newPattern.inhale !== this._pattern.inhale ||
        newPattern.exhale !== this._pattern.exhale) {
      this._pattern = newPattern;
      this.elapsed = 0;
    }
  }

  /** Update — call every frame with current time */
  update(time: number): void {
    if (!this.started) {
      this.lastTime = time;
      this.started = true;
    }

    const dt = time - this.lastTime;
    this.lastTime = time;
    // Don't advance elapsed during forced mode (prevents clock drift)
    if (!this._forced) {
      this.elapsed += dt;
    }

    const total = this.cycleDuration;
    if (total <= 0) return;

    // Wrap elapsed into cycle
    const cycleTime = this.elapsed % total;
    this._cycleProgress = cycleTime / total;

    const { inhale, holdIn, exhale, holdOut } = this._pattern;

    let value: number;

    if (cycleTime < inhale) {
      // Inhale: 0 → 1
      this._stage = 'inhale';
      value = cycleTime / inhale;
    } else if (cycleTime < inhale + holdIn) {
      // Hold after inhale: stay at 1
      this._stage = 'hold-in';
      value = 1;
    } else if (cycleTime < inhale + holdIn + exhale) {
      // Exhale: 1 → 0
      this._stage = 'exhale';
      value = 1 - (cycleTime - inhale - holdIn) / exhale;
    } else {
      // Hold after exhale: stay at 0
      this._stage = 'hold-out';
      value = 0;
    }

    if (this._forced) {
      // Breathing guide controls value directly — skip internal computation
      this._value = this._forceValue;
      this._phase = this._value * Math.PI; // approximate phase for shader
      return;
    } else {
      // Normal: cosine interpolation
      this._value = this.smoothStep(value);
    }

    this._phase = this._cycleProgress * Math.PI * 2;
  }

  private _forced = false;
  private _forceValue = 0;

  /** Force a specific breath stage AND value (0-1).
   *  Used by audio-driven breathing guide for smooth control. */
  forceStage(stage: BreathStage, value?: number): void {
    this._forced = true;
    this._stage = stage;
    if (value !== undefined) {
      this._forceValue = value;
    }
  }

  /** Set the forced value directly (called every frame by breathing guide) */
  forceValue(value: number): void {
    this._forced = true;
    this._forceValue = value;
  }

  /** Release forced control, let the internal clock resume */
  releaseForce(): void {
    this._forced = false;
  }

  /** Override with mic-detected breath */
  setFromMic(breathPhase01: number): void {
    this._value = breathPhase01;
    this._phase = breathPhase01 * Math.PI * 2;
    this._stage = breathPhase01 > 0.5 ? 'inhale' : 'exhale';
    this._cycleProgress = breathPhase01;
  }

  private smoothStep(t: number): number {
    return (1 - Math.cos(t * Math.PI)) / 2;
  }

  // ── Bus-driven lifecycle ──────────────────────────────────────
  private busUnsubs: Array<() => void> = [];

  connectBus(bus: import('./events').EventBus): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];

    this.busUnsubs.push(bus.on('stage:changed', ({ stage }) => {
      if (stage.breathPattern) {
        this.setPattern({
          inhale: stage.breathPattern.inhale,
          holdIn: stage.breathPattern.holdIn ?? 0,
          exhale: stage.breathPattern.exhale,
          holdOut: stage.breathPattern.holdOut ?? 0,
        });
      } else {
        this.setSimpleCycle(stage.breathCycle);
      }
    }));
  }

  dispose(): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
  }
}
