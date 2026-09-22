/**
 * CueScheduler — pure, position-driven cue dispatch.
 *
 * `tick(position)` emits `enter` for point cues crossed since the last
 * tick and `enter`/`exit` for windowed cues (breath, gate). `seek(position)`
 * re-derives the windowed cues that should be active and the latest state
 * cues (intensity, anchor, pattern) without firing skipped point cues.
 */

import type { Cue, CueType } from '@content/schema';

export interface CueEvent { kind: 'enter' | 'exit'; cue: Cue }

function windowOf(c: Cue): number {
  if (c.type === 'breath') return c.dur;
  if (c.type === 'gate') return c.window;
  return 0;
}

const STATE_TYPES: ReadonlySet<CueType> = new Set<CueType>(['intensity', 'anchor', 'pattern']);

export class CueScheduler {
  private readonly cues: readonly Cue[];
  private nextIdx = 0;
  private position = 0;
  private active = new Set<Cue>();

  constructor(cues: readonly Cue[]) {
    this.cues = [...cues].sort((a, b) => a.t - b.t);
  }

  get activeCues(): readonly Cue[] { return [...this.active]; }

  /** Advance forward. Backward motion is treated as a seek. */
  tick(position: number): CueEvent[] {
    if (position < this.position - 0.05) return this.seek(position);
    const events: CueEvent[] = [];
    // exits first so a cue can't enter and exit in the wrong order
    for (const c of this.active) {
      if (position >= c.t + windowOf(c)) { this.active.delete(c); events.push({ kind: 'exit', cue: c }); }
    }
    while (this.nextIdx < this.cues.length) {
      const c = this.cues[this.nextIdx]!;
      if (c.t > position) break;
      this.nextIdx++;
      events.push({ kind: 'enter', cue: c });
      if (windowOf(c) > 0 && position < c.t + windowOf(c)) this.active.add(c);
      else if (windowOf(c) > 0) events.push({ kind: 'exit', cue: c });
    }
    this.position = position;
    return events;
  }

  /**
   * Jump to a position. Returns exits for windows no longer active, enters
   * for windows now active, and enters for the latest state cue of each type
   * at or before the position (so callers can restore intensity/anchor/pattern).
   */
  seek(position: number): CueEvent[] {
    const events: CueEvent[] = [];
    const nowActive = new Set<Cue>();
    const latestState = new Map<CueType, Cue>();
    let idx = 0;
    for (; idx < this.cues.length; idx++) {
      const c = this.cues[idx]!;
      if (c.t > position) break;
      if (STATE_TYPES.has(c.type)) latestState.set(c.type, c);
      if (windowOf(c) > 0 && position < c.t + windowOf(c)) nowActive.add(c);
    }
    for (const c of this.active) if (!nowActive.has(c)) events.push({ kind: 'exit', cue: c });
    for (const c of latestState.values()) events.push({ kind: 'enter', cue: c });
    for (const c of nowActive) if (!this.active.has(c)) events.push({ kind: 'enter', cue: c });
    this.active = nowActive;
    this.nextIdx = idx;
    this.position = position;
    return events;
  }

  /** Force a windowed cue out early (gate answered). */
  release(cue: Cue): CueEvent[] {
    if (!this.active.delete(cue)) return [];
    return [{ kind: 'exit', cue }];
  }
}
