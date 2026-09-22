import { describe, it, expect, beforeEach } from 'vitest';
import { Player } from '../player';
import { FakeFactory } from './fake-media';
import { fixturePackage } from '@content/__tests__/fixture';

function make(mode: 'watch' | 'listen' = 'watch'): { p: Player; f: FakeFactory; run: (seconds: number) => void; log: string[] } {
  const f = new FakeFactory({ 'a.webm': 40, 'b.webm': 60, 'c.webm': 30, 'bed.webm': 600 });
  const p = new Player({ pkg: fixturePackage(), baseUrl: '/s/fixture/', mode, media: f });
  const log: string[] = [];
  p.events.on('cue', e => log.push(`${e.kind}:${e.cue.type}@${e.cue.t}`));
  p.events.on('gate', e => log.push(`gate:${e.phase}@${e.gate.cue.t}`));
  p.events.on('stage', e => log.push(`stage:${e.stage.name}`));
  p.events.on('state', s => log.push(`state:${s}`));
  p.events.on('ended', () => log.push('ended'));
  const run = (seconds: number): void => {
    const step = 0.25;
    for (let t = 0; t < seconds - 1e-9; t += step) { f.advance(step); p.tick(step); }
  };
  return { p, f, run, log };
}

describe('Player', () => {
  let ctx: ReturnType<typeof make>;
  beforeEach(() => { ctx = make(); });

  it('starts the bed and first stage, and dispatches cues in order', async () => {
    const { p, f, run, log } = ctx;
    await p.play();
    expect(p.state).toBe('playing');
    expect(f.live.map(e => e.src.split('/').pop())).toEqual(['bed.webm', 'a.webm']);
    run(6);
    expect(log.filter(l => l.startsWith('enter'))).toEqual(['enter:anchor@0', 'enter:intensity@2', 'enter:breath@5']);
    expect(p.intensity).toBe(0.2);
  });

  it('opens a gate at its cue, closes it on timeout, and keeps playing', async () => {
    const { p, run, log } = ctx;
    await p.play();
    run(36);
    expect(p.gate?.cue.t).toBe(35);
    run(6);
    expect(p.gate).toBeNull();
    expect(log).toContain('gate:open@35');
    expect(log).toContain('gate:closed@35');
    expect(p.state).toBe('playing');
  });

  it('answering a gate skips the silent window', async () => {
    const { p, run } = ctx;
    await p.play();
    run(36);
    expect(await p.answerGate()).toBe(true);
    expect(p.position).toBeCloseTo(41, 1);
    expect(p.gate).toBeNull();
    expect(await p.answerGate()).toBe(false);
  });

  it('crosses stage boundaries via ended events, prebuffering the next stage', async () => {
    const { p, f, run, log } = ctx;
    await p.play();
    run(33);
    expect(f.created.some(e => e.src.endsWith('b.webm'))).toBe(true); // prebuffered 8s ahead
    run(8);
    expect(p.stage.name).toBe('b');
    expect(p.position).toBeCloseTo(41, 0);
    expect(log.filter(l => l.startsWith('stage'))).toEqual(['stage:a', 'stage:b']);
    // trigger at 41 fires right after the boundary
    run(1);
    expect(log).toContain('enter:trigger@41');
  });

  it('ramps intensity over the cue ramp', async () => {
    const { p, run } = ctx;
    await p.play();
    run(61);
    const mid = p.intensity;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
    run(10);
    expect(p.intensity).toBeCloseTo(0.8, 5);
  });

  it('ends after the last stage', async () => {
    const { p, run, log } = ctx;
    await p.play();
    run(131);
    expect(p.state).toBe('ended');
    expect(log[log.length - 1]).toBe('ended');
  });

  it('pauses and resumes without drift', async () => {
    const { p, f, run } = ctx;
    await p.play();
    run(10);
    p.pause();
    const pos = p.position;
    f.advance(5); p.tick(5);
    expect(p.position).toBeCloseTo(pos, 5);
    expect(f.live.length).toBe(0);
    await p.resume();
    run(2);
    expect(p.position).toBeCloseTo(pos + 2, 1);
  });

  it('seeks across stages and restores state cues without firing skipped triggers', async () => {
    const { p, run, log } = ctx;
    await p.play();
    run(3);
    await p.seek(97);
    expect(p.stage.name).toBe('b');
    expect(p.gate?.cue.t).toBe(95);
    expect(log).toContain('enter:intensity@60');
    expect(log).not.toContain('enter:trigger@41');
    run(4);
    expect(p.stage.name).toBe('c');
    expect(log).toContain('enter:anchor@100');
  });

  it('seek while paused stays paused', async () => {
    const { p, f, run } = ctx;
    await p.play();
    run(2);
    p.pause();
    await p.seek(50);
    expect(p.state).toBe('paused');
    expect(f.live.length).toBe(0);
    expect(p.position).toBeCloseTo(50, 1);
  });

  it('resolves text for the current position', async () => {
    const { p, run } = ctx;
    await p.play();
    run(1.75);
    const r = p.textAt();
    expect(r.line?.text).toBe('you are here');
    expect(r.wordIndex).toBe(1);
  });
});
