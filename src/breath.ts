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

  /** Set a new breath pattern */
  setPattern(pattern: Partial<BreathPattern>): void {
    this._pattern = { ...this._pattern, ...pattern };
  }

  /** Set pattern from a simple cycle duration (equal inhale/exhale, no holds) */
  setSimpleCycle(durationSeconds: number): void {
    const half = durationSeconds / 2;
    this._pattern = { inhale: half, holdIn: 0, exhale: half, holdOut: 0 };
  }

  /** Update — call every frame with current time */
  update(time: number): void {
    if (!this.started) {
      this.lastTime = time;
      this.started = true;
    }

    const dt = time - this.lastTime;
    this.lastTime = time;
    this.elapsed += dt;

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

    // Smooth with cosine interpolation for natural feel
    this._value = this.smoothStep(value);

    // Convert to phase in radians (shader expects sin(phase)*0.5+0.5 = value)
    // So phase = asin((value - 0.5) * 2) but that's discontinuous
    // Instead, map cycle progress to 0..2PI so shader breathe() works
    this._phase = this._cycleProgress * Math.PI * 2;
  }

  /** Override with mic-detected breath */
  setFromMic(breathPhase01: number): void {
    this._value = breathPhase01;
    this._phase = breathPhase01 * Math.PI * 2;
    this._stage = breathPhase01 > 0.5 ? 'inhale' : 'exhale';
    this._cycleProgress = breathPhase01;
  }

  private smoothStep(t: number): number {
    // Cosine interpolation for smooth breath curve
    return (1 - Math.cos(t * Math.PI)) / 2;
  }
}
