import { describe, it, expect } from 'vitest';
import { CueScheduler } from '../cues';
import { fixturePackage } from '@content/__tests__/fixture';

const sig = (evs: { kind: string; cue: { type: string; t: number } }[]): string[] => evs.map(e => `${e.kind}:${e.cue.type}@${e.cue.t}`);

describe('CueScheduler', () => {
  it('fires point cues once and opens/closes windows', () => {
    const s = new CueScheduler(fixturePackage().cues);
    expect(sig(s.tick(0))).toEqual(['enter:anchor@0']);
    expect(sig(s.tick(1))).toEqual([]);
    expect(sig(s.tick(6))).toEqual(['enter:intensity@2', 'enter:breath@5']);
    expect(s.activeCues.length).toBe(1);
    expect(sig(s.tick(24.9))).toEqual([]);
    expect(sig(s.tick(25))).toEqual(['exit:breath@5']);
    expect(sig(s.tick(36))).toEqual(['enter:gate@35']);
    expect(sig(s.tick(41))).toEqual(['exit:gate@35', 'enter:trigger@41']);
  });

  it('seek restores state cues and active windows without firing skipped triggers', () => {
    const s = new CueScheduler(fixturePackage().cues);
    s.tick(1);
    const evs = sig(s.seek(97));
    expect(evs).toContain('enter:intensity@60');
    expect(evs).toContain('enter:anchor@0');
    expect(evs).toContain('enter:gate@95');
    expect(evs).not.toContain('enter:trigger@41');
    expect(sig(s.tick(100))).toEqual(['exit:gate@95', 'enter:anchor@100']);
  });

  it('backward tick is treated as a seek and exits windows', () => {
    const s = new CueScheduler(fixturePackage().cues);
    s.tick(37);
    expect(s.activeCues.length).toBe(1);
    const evs = sig(s.tick(10));
    expect(evs).toContain('exit:gate@35');
    expect(evs).toContain('enter:breath@5');
  });

  it('release ends a window early', () => {
    const s = new CueScheduler(fixturePackage().cues);
    s.tick(36);
    const gate = s.activeCues[0]!;
    expect(sig(s.release(gate))).toEqual(['exit:gate@35']);
    expect(sig(s.tick(41))).toEqual(['enter:trigger@41']);
  });
});
