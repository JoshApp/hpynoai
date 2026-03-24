/**
 * Clock abstraction — swappable time source for the timeline transport.
 *
 * Live sessions use realtimeClock (wall clock).
 * Video export uses VirtualClock (stepped manually).
 */

export interface Clock {
  /** Current time in seconds (monotonic) */
  now(): number;
}

/** Wall clock — wraps performance.now() */
export const realtimeClock: Clock = {
  now: () => performance.now() / 1000,
};

/** Virtual clock — advanced manually, for deterministic playback / video export */
export class VirtualClock implements Clock {
  private _time = 0;

  now(): number { return this._time; }

  advance(dt: number): void { this._time += dt; }

  seek(t: number): void { this._time = t; }

  reset(): void { this._time = 0; }
}
