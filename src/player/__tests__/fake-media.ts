import type { MediaFactory, MediaLike } from '../media';

/** Deterministic media element: advances only when the test clock advances. */
export class FakeMedia implements MediaLike {
  src: string;
  currentTime = 0;
  duration: number;
  paused = true;
  ended = false;
  loop = false;
  volume = 1;
  preload = 'auto';
  private listeners = new Map<string, Set<() => void>>();
  playCalls = 0;

  constructor(src: string, duration: number) { this.src = src; this.duration = duration; }

  async play(): Promise<void> { this.paused = false; this.playCalls++; }
  pause(): void { this.paused = true; }
  load(): void { /* noop */ }
  addEventListener(t: string, fn: () => void): void {
    let s = this.listeners.get(t); if (!s) { s = new Set(); this.listeners.set(t, s); } s.add(fn);
  }
  removeEventListener(t: string, fn: () => void): void { this.listeners.get(t)?.delete(fn); }

  /** Advance the element's clock; fires `ended` when it reaches its duration. */
  advance(dt: number): void {
    if (this.paused || this.ended) return;
    this.currentTime += dt;
    if (this.currentTime >= this.duration) {
      this.currentTime = this.duration; this.ended = true; this.paused = true;
      for (const fn of this.listeners.get('ended') ?? []) fn();
    }
  }
}

export class FakeFactory implements MediaFactory {
  created: FakeMedia[] = [];
  constructor(private durations: Record<string, number>) {}
  canPlayOpus(): boolean { return true; }
  create(url: string): MediaLike {
    const name = url.split('/').pop() ?? url;
    const dur = this.durations[name] ?? 60;
    const el = new FakeMedia(url, dur);
    this.created.push(el);
    return el;
  }
  /** Advance every non-paused element. */
  advance(dt: number): void { for (const el of this.created) el.advance(dt); }
  get live(): FakeMedia[] { return this.created.filter(e => !e.paused); }
}
