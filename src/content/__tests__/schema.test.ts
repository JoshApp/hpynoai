import { describe, it, expect } from 'vitest';
import { parseSessionPackage, parseSessionIndex, stageStarts, totalDuration, ContentError } from '../schema';
import { fixturePackage } from './fixture';

describe('parseSessionPackage', () => {
  it('round-trips a valid package and sorts cues', () => {
    const raw = fixturePackage() as unknown as Record<string, unknown>;
    (raw.cues as unknown[]).reverse();
    const pkg = parseSessionPackage(raw);
    expect(pkg.cues.map(c => c.t)).toEqual([0, 2, 5, 35, 41, 60, 95, 100]);
    expect(stageStarts(pkg)).toEqual([0, 40, 100]);
    expect(totalDuration(pkg)).toBe(130);
    expect(pkg.audio.bed?.gainDb).toBe(-6);
  });

  it('keeps optional cue ids', () => {
    const raw = fixturePackage() as unknown as { cues: Record<string, unknown>[] };
    raw.cues[3]!['id'] = 'a:gate:0';
    const pkg = parseSessionPackage(raw);
    expect(pkg.cues.find(c => c.type === 'gate')?.id).toBe('a:gate:0');
  });

  it('rejects wrong schema version', () => {
    expect(() => parseSessionPackage({ ...fixturePackage(), schema: 1 })).toThrow(ContentError);
  });

  it('rejects cues past the end', () => {
    const raw = fixturePackage();
    raw.cues.push({ t: 500, type: 'trigger', kind: 'drop' });
    expect(() => parseSessionPackage(raw)).toThrow(/past the end/);
  });

  it('rejects text stages without audio stages', () => {
    const raw = fixturePackage();
    raw.text!.stages.push({ name: 'zzz', lines: [] });
    expect(() => parseSessionPackage(raw)).toThrow(/no audio stage/);
  });

  it('rejects bad cue types with a path', () => {
    const raw = fixturePackage() as unknown as { cues: unknown[] };
    raw.cues.push({ t: 1, type: 'wat' });
    expect(() => parseSessionPackage(raw)).toThrow(/cues\[8\]\.type/);
  });

  it('parses an index', () => {
    const idx = parseSessionIndex({ schema: 2, sessions: [{ id: 's', title: 'S', durationSec: 10, intensity: 9 }] });
    expect(idx.sessions[0]?.intensity).toBe(3);
    expect(idx.sessions[0]?.rating).toBe('adult');
    expect(() => parseSessionIndex({ version: 1 })).toThrow(ContentError);
  });
});
