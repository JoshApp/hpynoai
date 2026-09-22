/**
 * Media abstraction — the slice of HTMLMediaElement the player needs,
 * so the core can run headless against a fake clock in tests.
 */

export interface MediaLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  loop: boolean;
  volume: number;
  preload: string;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: 'ended' | 'error' | 'canplay', fn: () => void): void;
  removeEventListener(type: 'ended' | 'error' | 'canplay', fn: () => void): void;
}

export interface MediaFactory {
  create(url: string): MediaLike;
  /** Attach for analysis (watch mode). No-op in tests / listen mode. */
  attach?(el: MediaLike, role: 'voice' | 'bed'): void;
  /** Whether Opus/WebM can be played. Defaults to a DOM probe. */
  canPlayOpus?(): boolean;
}

let opusSupport: boolean | null = null;
export function canPlayOpus(): boolean {
  if (opusSupport === null) {
    try { opusSupport = !!document.createElement('audio').canPlayType('audio/webm; codecs=opus').replace('no', ''); }
    catch { opusSupport = false; }
  }
  return opusSupport;
}

export const domMediaFactory: MediaFactory = {
  canPlayOpus,
  create(url: string): MediaLike {
    const el = new Audio();
    el.preload = 'auto';
    (el as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
    el.crossOrigin = 'anonymous';
    el.src = url;
    return el as unknown as MediaLike;
  },
};
