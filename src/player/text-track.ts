/**
 * TextTrack — resolves narration text for a position. Pure.
 * Line and word times in the package are stage-relative; this class
 * flattens them to absolute seconds once.
 */

import type { SessionPackage, TextLine, WordTiming } from '@content/schema';
import { stageStarts } from '@content/schema';

export interface AbsLine extends TextLine { stage: string; absStart: number; absEnd: number; absWords: WordTiming[] }

export interface TextReading {
  line: AbsLine | null;
  /** Index into line.absWords, -1 before the first word */
  wordIndex: number;
  /** Seconds since the line started (absolute clock) */
  elapsed: number;
}

export class TextTrack {
  readonly lines: AbsLine[] = [];
  private idx = 0;

  constructor(pkg: SessionPackage) {
    const starts = stageStarts(pkg);
    for (const ts of pkg.text?.stages ?? []) {
      const si = pkg.audio.stages.findIndex(s => s.name === ts.name);
      if (si < 0) continue;
      const base = starts[si] ?? 0;
      for (const l of ts.lines) {
        this.lines.push({
          ...l, stage: ts.name,
          absStart: base + l.start, absEnd: base + l.end,
          absWords: l.words.map(w => ({ w: w.w, s: base + w.s, e: base + w.e })),
        });
      }
    }
    this.lines.sort((a, b) => a.absStart - b.absStart);
  }

  /** Reading at an absolute position. Lines linger `hold` seconds after their end. */
  at(position: number, hold = 0.6): TextReading {
    // Monotonic fast path, with fallback to binary-ish scan on seeks
    if (this.idx >= this.lines.length || position < (this.lines[this.idx]?.absStart ?? Infinity) - 0.001) this.idx = 0;
    let line: AbsLine | null = null;
    for (let i = this.idx; i < this.lines.length; i++) {
      const l = this.lines[i]!;
      if (l.absStart > position) break;
      this.idx = i;
      if (position < l.absEnd + hold) line = l;
    }
    if (!line) return { line: null, wordIndex: -1, elapsed: 0 };
    let wordIndex = -1;
    for (let i = 0; i < line.absWords.length; i++) {
      const w = line.absWords[i]!;
      const next = line.absWords[i + 1]?.s ?? w.e + hold;
      if (position >= w.s && position < next) { wordIndex = i; break; }
    }
    return { line, wordIndex, elapsed: position - line.absStart };
  }
}
