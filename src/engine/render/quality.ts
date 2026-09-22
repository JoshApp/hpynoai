/**
 * QualityManager — adaptive quality with hysteresis.
 *
 * Samples frame time, steps the level down after sustained low FPS and
 * back up after sustained good FPS. Levels map to pixel ratio, feedback
 * warp on/off, and a particle budget. The renderer applies the level;
 * this class only decides.
 */

export type QualityLevel = 'high' | 'medium' | 'low';

export interface QualityProfile {
  pixelRatio: number;
  feedback: boolean;
  particleBudget: number;
}

const ORDER: QualityLevel[] = ['low', 'medium', 'high'];

export class QualityManager {
  private profiles: Record<QualityLevel, QualityProfile>;
  private idx: number;
  private forced: QualityLevel | null = null;
  private lowFrames = 0;
  private highFrames = 0;
  private fpsEma = 60;
  private listeners = new Set<(level: QualityLevel, profile: QualityProfile) => void>();

  static readonly LOW_FPS = 28;
  static readonly HIGH_FPS = 52;
  static readonly STEP_DOWN_AFTER = 90;
  static readonly STEP_UP_AFTER = 300;

  constructor(maxPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5), initial: QualityLevel = 'high') {
    this.profiles = {
      high: { pixelRatio: maxPixelRatio, feedback: true, particleBudget: 1 },
      medium: { pixelRatio: Math.min(maxPixelRatio, 1), feedback: true, particleBudget: 0.6 },
      low: { pixelRatio: Math.min(maxPixelRatio, 0.75), feedback: false, particleBudget: 0 },
    };
    this.idx = ORDER.indexOf(initial);
  }

  get level(): QualityLevel { return this.forced ?? ORDER[this.idx]!; }
  get profile(): QualityProfile { return this.profiles[this.level]; }
  get fps(): number { return this.fpsEma; }

  onChange(cb: (level: QualityLevel, profile: QualityProfile) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Pin a level (settings, reduced-motion) or null to resume auto. */
  force(level: QualityLevel | null): void {
    const before = this.level;
    this.forced = level;
    if (level) this.idx = ORDER.indexOf(level);
    if (this.level !== before) this.emit();
  }

  /** Feed one frame's dt (seconds). */
  sample(dt: number): void {
    if (dt <= 0) return;
    const fps = 1 / dt;
    this.fpsEma += (fps - this.fpsEma) * 0.1;
    if (this.forced) return;

    if (fps < QualityManager.LOW_FPS) { this.lowFrames++; this.highFrames = 0; }
    else if (fps > QualityManager.HIGH_FPS) { this.highFrames++; this.lowFrames = 0; }
    else { this.lowFrames = Math.max(0, this.lowFrames - 1); this.highFrames = Math.max(0, this.highFrames - 1); }

    if (this.lowFrames > QualityManager.STEP_DOWN_AFTER && this.idx > 0) {
      this.idx--; this.lowFrames = 0; this.highFrames = 0; this.emit();
    } else if (this.highFrames > QualityManager.STEP_UP_AFTER && this.idx < ORDER.length - 1) {
      this.idx++; this.lowFrames = 0; this.highFrames = 0; this.emit();
    }
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.level, this.profile);
  }
}
