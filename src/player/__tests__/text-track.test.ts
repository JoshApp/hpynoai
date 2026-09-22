import { describe, it, expect } from 'vitest';
import { TextTrack } from '../text-track';
import { fixturePackage } from '@content/__tests__/fixture';

describe('TextTrack', () => {
  const tt = new TextTrack(fixturePackage());

  it('flattens stage-relative times to absolute', () => {
    expect(tt.lines.map(l => l.absStart)).toEqual([1, 10, 40.5]);
  });

  it('resolves line and word at a position', () => {
    expect(tt.at(0.5).line).toBeNull();
    const r = tt.at(1.7);
    expect(r.line?.text).toBe('you are here');
    expect(r.wordIndex).toBe(1);
    expect(tt.at(3).wordIndex).toBe(2);
  });

  it('lingers after line end, then clears', () => {
    expect(tt.at(4.3).line?.text).toBe('you are here');
    expect(tt.at(5).line).toBeNull();
  });

  it('handles seeks backward', () => {
    expect(tt.at(41).line?.text).toBe('deeper now');
    expect(tt.at(10.5).line?.text).toBe('breathe');
  });
});
