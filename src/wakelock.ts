/**
 * Screen Wake Lock + Background Audio Keep-Alive.
 *
 * Mobile browsers kill WebAudio (oscillators, gain nodes) when the screen
 * locks or the tab backgrounds. But they keep HTMLMediaElement playback alive
 * (that's how Spotify/YouTube work). The trick: play a silent <audio> loop
 * during the session. This keeps the audio session active, and WebAudio
 * piggybacks on it.
 *
 * Also registers a Media Session so the OS shows HPYNO on the lock screen
 * and doesn't kill the tab.
 */

let wakeLock: WakeLockSentinel | null = null;
let silentAudio: HTMLAudioElement | null = null;

// ── Wake Lock ──────────────────────────────────────────────────

export async function acquireWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {
    // Permission denied or not supported
  }
}

export function releaseWakeLock(): void {
  wakeLock?.release();
  wakeLock = null;
}

// Re-acquire after visibility change (auto-released when tab hidden)
document.addEventListener('visibilitychange', () => {
  if (wakeLock === null && document.visibilityState === 'visible') {
    acquireWakeLock();
  }
});

// ── Silent Audio Keep-Alive ────────────────────────────────────
// A tiny silent audio loop that keeps the browser audio session
// alive when the screen is locked. WebAudio oscillators/nodes
// continue running because the browser thinks media is playing.

// Base64 of a ~1 second silent MP3 (smallest valid MP3)
const SILENT_MP3 = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwmHAAAAAAD/+1DEAAAHAAGf9AAAIiSAM/80AAAATQBQAAAAAABBBP/+nf//5cGH///LABQAAABgAAAAAAAtIFAAABQALCADYfnf5f/JKf/+3DEAQAHmAmZ9GAAACUAM380AAAFBgAUFJBUQTEFNRTMuOTkuNVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

/**
 * Start the silent audio loop. Call from a user gesture context
 * (e.g. when starting a session) so autoplay restrictions are satisfied.
 */
export function startSilentAudioKeepAlive(): void {
  if (silentAudio) return;

  silentAudio = new Audio(SILENT_MP3);
  silentAudio.loop = true;
  silentAudio.volume = 0.01; // near-silent, not exactly 0 (some browsers optimize away 0)
  silentAudio.play().catch(() => {
    // Autoplay blocked — will try again on next user gesture
    silentAudio = null;
  });
}

/** Stop the silent audio loop. */
export function stopSilentAudioKeepAlive(): void {
  if (silentAudio) {
    silentAudio.pause();
    silentAudio.src = '';
    silentAudio = null;
  }
}

// ── Media Session ──────────────────────────────────────────────

export function registerMediaSession(title: string): void {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: 'HPYNO',
    album: 'Immersive Hypnosis',
  });

  navigator.mediaSession.setActionHandler('play', () => {});
  navigator.mediaSession.setActionHandler('pause', () => {});
}

export function clearMediaSession(): void {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = null;
}
