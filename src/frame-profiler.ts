/**
 * Frame budget profiler — zero-allocation timing for the animate loop.
 *
 * Wraps subsystem calls in performance.now() and stores results in
 * pre-allocated typed arrays to avoid GC pressure. Exposes latest
 * frame budget + rolling 60-frame average.
 */

/** Budget keys in fixed order — matches typed array slot indices */
export const BUDGET_KEYS = [
  'timeline', 'narration', 'breath', 'audio',
  'interactions', 'text3d', 'ambient', 'render', 'other',
] as const;

export type BudgetKey = (typeof BUDGET_KEYS)[number];

export interface FrameBudget {
  total: number;
  timeline: number;
  narration: number;
  breath: number;
  audio: number;
  interactions: number;
  text3d: number;
  ambient: number;
  render: number;
  other: number;
}

const KEY_COUNT = BUDGET_KEYS.length;
const RING_SIZE = 60;

export class FrameProfiler {
  // Ring buffer: RING_SIZE frames × KEY_COUNT slots
  private ring = new Float64Array(RING_SIZE * KEY_COUNT);
  private totals = new Float64Array(RING_SIZE);
  private head = 0;
  private frameCount = 0;

  // Current frame accumulator
  private current = new Float64Array(KEY_COUNT);
  private frameStart = 0;
  private lastMark = 0;

  /** Call at the start of animate() */
  beginFrame(): void {
    this.current.fill(0);
    this.frameStart = performance.now();
    this.lastMark = this.frameStart;
  }

  /** Mark the end of a named phase */
  mark(key: BudgetKey): void {
    const now = performance.now();
    const idx = BUDGET_KEYS.indexOf(key);
    if (idx >= 0) {
      this.current[idx] = now - this.lastMark;
    }
    this.lastMark = now;
  }

  /** Call at the end of animate() */
  endFrame(): void {
    const total = performance.now() - this.frameStart;

    // Compute "other" as total minus all tracked phases
    let tracked = 0;
    for (let i = 0; i < KEY_COUNT - 1; i++) tracked += this.current[i];
    this.current[KEY_COUNT - 1] = Math.max(0, total - tracked);

    // Write to ring
    const offset = this.head * KEY_COUNT;
    for (let i = 0; i < KEY_COUNT; i++) {
      this.ring[offset + i] = this.current[i];
    }
    this.totals[this.head] = total;

    this.head = (this.head + 1) % RING_SIZE;
    this.frameCount++;
  }

  /** Latest frame budget (ms) */
  getLatest(): FrameBudget {
    const prev = ((this.head - 1) + RING_SIZE) % RING_SIZE;
    const offset = prev * KEY_COUNT;
    const result: Record<string, number> = { total: this.totals[prev] };
    for (let i = 0; i < KEY_COUNT; i++) {
      result[BUDGET_KEYS[i]] = this.ring[offset + i];
    }
    return result as unknown as FrameBudget;
  }

  /** Rolling average over the last N frames (default 60) */
  getAverage(n = RING_SIZE): FrameBudget {
    const count = Math.min(n, this.frameCount, RING_SIZE);
    if (count === 0) return this.emptyBudget();

    const sums = new Float64Array(KEY_COUNT);
    let totalSum = 0;

    for (let f = 0; f < count; f++) {
      const idx = ((this.head - 1 - f) + RING_SIZE * 2) % RING_SIZE;
      const offset = idx * KEY_COUNT;
      for (let i = 0; i < KEY_COUNT; i++) {
        sums[i] += this.ring[offset + i];
      }
      totalSum += this.totals[idx];
    }

    const result: Record<string, number> = { total: totalSum / count };
    for (let i = 0; i < KEY_COUNT; i++) {
      result[BUDGET_KEYS[i]] = sums[i] / count;
    }
    return result as unknown as FrameBudget;
  }

  /** JSON-serializable snapshot for DevTools */
  getFrameBudget(): { latest: FrameBudget; avg60: FrameBudget; frames: number } {
    return {
      latest: this.getLatest(),
      avg60: this.getAverage(),
      frames: this.frameCount,
    };
  }

  private emptyBudget(): FrameBudget {
    return {
      total: 0, timeline: 0, narration: 0, breath: 0,
      audio: 0, interactions: 0, text3d: 0, ambient: 0,
      render: 0, other: 0,
    };
  }
}
