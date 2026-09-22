/** OS media controls (lock screen, headset buttons). */

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  seekTo(seconds: number): void;
  seekBy(deltaSeconds: number): void;
  /** "next track" doubles as the gate answer in listen mode */
  next(): void;
  stop(): void;
}

export function setupMediaSession(meta: { title: string; artist: string; artwork?: string }, h: MediaSessionHandlers): () => void {
  if (!('mediaSession' in navigator)) return () => {};
  const ms = navigator.mediaSession;
  ms.metadata = new MediaMetadata({
    title: meta.title,
    artist: meta.artist,
    artwork: meta.artwork ? [{ src: meta.artwork, sizes: '512x512', type: 'image/png' }] : [],
  });
  const set = (a: MediaSessionAction, fn: MediaSessionActionHandler | null): void => {
    try { ms.setActionHandler(a, fn); } catch { /* unsupported action */ }
  };
  set('play', () => h.play());
  set('pause', () => h.pause());
  set('stop', () => h.stop());
  set('nexttrack', () => h.next());
  set('seekto', (d) => { if (d.seekTime !== undefined) h.seekTo(d.seekTime); });
  set('seekforward', (d) => h.seekBy(d.seekOffset ?? 15));
  set('seekbackward', (d) => h.seekBy(-(d.seekOffset ?? 15)));
  return () => {
    for (const a of ['play', 'pause', 'stop', 'nexttrack', 'seekto', 'seekforward', 'seekbackward'] as MediaSessionAction[]) set(a, null);
    ms.metadata = null;
  };
}

export function updatePlaybackState(state: 'playing' | 'paused' | 'none', position?: number, duration?: number): void {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.playbackState = state;
  if (position !== undefined && duration !== undefined && Number.isFinite(duration) && duration > 0) {
    try { ms.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 }); } catch { /* ok */ }
  }
}
