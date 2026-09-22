import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseSessionPackage, parseSessionIndex, totalDuration } from '../schema';
import { TextTrack } from '@player/text-track';

const pub = process.env['HPYNO_PUBLIC'] ? new URL(`file://${process.env['HPYNO_PUBLIC'].replace(/\/?$/, '/')}`) : new URL('../../../public/', import.meta.url);
const read = (p: string): unknown => JSON.parse(readFileSync(new URL(p, pub), 'utf8'));

describe('shipped packages', () => {
  it('index parses and every listed package exists and parses', () => {
    const idx = parseSessionIndex(read('sessions.json'));
    expect(idx.sessions.length).toBeGreaterThan(0);
    for (const s of idx.sessions) {
      const path = `sessions/${s.id}/session.v2.json`;
      expect(existsSync(new URL(path, pub)), path).toBe(true);
      const pkg = parseSessionPackage(read(path));
      expect(pkg.id).toBe(s.id);
      expect(Math.abs(totalDuration(pkg) - pkg.durationSec)).toBeLessThan(1);
      for (const st of pkg.audio.stages) {
        expect(existsSync(new URL(`sessions/${s.id}/${st.file}`, pub)), st.file).toBe(true);
        if (st.fileMp3) expect(existsSync(new URL(`sessions/${s.id}/${st.fileMp3}`, pub)), st.fileMp3).toBe(true);
      }
      if (pkg.audio.bed) expect(existsSync(new URL(`sessions/${s.id}/${pkg.audio.bed.file}`, pub))).toBe(true);
      const tt = new TextTrack(pkg);
      for (const l of tt.lines) {
        expect(l.absEnd).toBeGreaterThanOrEqual(l.absStart);
        expect(l.absEnd).toBeLessThanOrEqual(totalDuration(pkg) + 0.5);
      }
    }
  });

  it('surrender has two gates inside its stage audio and guided breathing', () => {
    const pkg = parseSessionPackage(read('sessions/surrender/session.v2.json'));
    const gates = pkg.cues.filter(c => c.type === 'gate');
    expect(gates.length).toBe(2);
    expect(pkg.cues.some(c => c.type === 'breath' && c.guided)).toBe(true);
    expect(pkg.cues.filter(c => c.type === 'trigger').length).toBeGreaterThan(0);
  });
});
