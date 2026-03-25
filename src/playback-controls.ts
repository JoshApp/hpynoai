/**
 * Playback controls — unified control strip for sessions.
 *
 * Merges play/pause, progress, volume, settings, fullscreen, and exit
 * into one bar. Replaces the floating corner buttons during sessions.
 *
 * Behavior:
 *   - Visible during sessions (not on menu)
 *   - Auto-hides after 4s of inactivity (fades to 15% opacity)
 *   - Tap/mousemove to reveal
 *   - In fullscreen: hidden by default, single tap reveals for 4s
 *   - Safe area insets for iPhone notch/home indicator
 *   - Touch targets ≥ 44px for mobile
 */

import type { Timeline } from './timeline';
import type { SettingsManager } from './settings';
import type { AudioCompositor } from './audio-compositor';
import type { NarrationEngine } from './narration';

export class PlaybackControls {
  private el: HTMLDivElement;
  private playPauseBtn: HTMLButtonElement;
  private progressBar: HTMLDivElement;
  private progressFill: HTMLDivElement;
  private timeLabel: HTMLSpanElement;
  private timeline: Timeline;
  private settings: SettingsManager;
  private audioCompositor: AudioCompositor;
  private narration: NarrationEngine | null = null;
  private dragging = false;
  private hideTimer: number | null = null;
  private _active = false;
  private _onExit: (() => void) | null = null;

  constructor(timeline: Timeline, settings: SettingsManager, audioCompositor: AudioCompositor) {
    this.timeline = timeline;
    this.settings = settings;
    this.audioCompositor = audioCompositor;

    this.el = document.createElement('div');
    this.el.className = 'playback-controls';
    this.el.innerHTML = `
      <div class="pb-timeline-row">
        <div class="pb-progress">
          <div class="pb-progress-fill"></div>
        </div>
      </div>
      <div class="pb-controls-row">
        <button class="pb-btn pb-playpause" aria-label="Play/Pause">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path class="pb-icon-pause" d="M6 4h4v16H6zM14 4h4v16h-4z"/>
            <path class="pb-icon-play" d="M8 5v14l11-7z" style="display:none"/>
          </svg>
        </button>
        <span class="pb-time">0:00</span>
        <div class="pb-spacer"></div>
        <label class="pb-vol-label" title="Ambient">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" opacity="0.4">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
          </svg>
          <input type="range" class="pb-vol-slider" data-key="ambientVolume" min="0" max="1.5" step="0.05">
        </label>
        <label class="pb-vol-label" title="Binaural">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" opacity="0.4">
            <path d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>
          </svg>
          <input type="range" class="pb-vol-slider" data-key="binauralVolume" min="0" max="1" step="0.05">
        </label>
        <label class="pb-vol-label" title="Narration">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" opacity="0.4">
            <path d="M9 13c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 8c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
          <input type="range" class="pb-vol-slider" data-key="narrationVolume" min="0" max="1.5" step="0.05">
        </label>
        <div class="pb-sep"></div>
        <button class="pb-btn pb-fullscreen" aria-label="Fullscreen">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" opacity="0.5">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
          </svg>
        </button>
        <button class="pb-btn pb-exit" aria-label="Exit session">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" opacity="0.5">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>
    `;

    document.body.appendChild(this.el);

    this.playPauseBtn = this.el.querySelector('.pb-playpause')!;
    this.progressBar = this.el.querySelector('.pb-progress')!;
    this.progressFill = this.el.querySelector('.pb-progress-fill')!;
    this.timeLabel = this.el.querySelector('.pb-time')!;

    // ── Inject styles ──
    const style = document.createElement('style');
    style.textContent = `
      .playback-controls {
        position: fixed; bottom: 0; left: 0; right: 0;
        display: none; flex-direction: column; gap: 2px;
        background: linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.3) 70%, transparent 100%);
        padding: 24px 16px 12px;
        padding-bottom: max(12px, env(safe-area-inset-bottom, 12px));
        font: 11px -apple-system, sans-serif; color: rgba(255, 255, 255, 0.6);
        z-index: 1000; user-select: none;
        transition: opacity 0.4s ease;
        pointer-events: auto; cursor: default;
        touch-action: none;
        box-sizing: border-box;
      }
      .pb-timeline-row {
        display: flex; align-items: center; width: 100%;
        padding: 0 4px;
      }
      .pb-progress {
        flex: 1; height: 3px; background: rgba(255, 255, 255, 0.12);
        border-radius: 2px; cursor: pointer; position: relative;
        padding: 10px 0; background-clip: content-box;
      }
      .pb-progress-fill {
        height: 100%; background: rgba(180, 140, 255, 0.5);
        border-radius: 2px; width: 0%; transition: width 0.1s linear;
        pointer-events: none;
      }
      .pb-controls-row {
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 0 4px;
      }
      .pb-btn {
        background: none; border: none; color: rgba(255, 255, 255, 0.7);
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; border-radius: 50%;
        min-width: 36px; min-height: 36px;
        transition: background 0.15s;
      }
      .pb-btn:hover { background: rgba(255,255,255,0.08); }
      .pb-btn:active { background: rgba(255,255,255,0.15); }
      .pb-time {
        font-variant-numeric: tabular-nums; font-size: 10px; opacity: 0.5;
        flex-shrink: 0;
      }
      .pb-spacer { flex: 1; }
      .pb-sep {
        width: 1px; height: 14px; background: rgba(255,255,255,0.1);
        flex-shrink: 0;
      }
      .pb-vol-label {
        display: flex; align-items: center; gap: 3px; cursor: pointer; flex-shrink: 0;
      }
      .pb-vol-slider {
        -webkit-appearance: none; appearance: none;
        width: 44px; height: 3px; border-radius: 2px;
        background: rgba(255,255,255,0.12); outline: none;
        cursor: pointer; flex-shrink: 0;
      }
      .pb-vol-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 14px; height: 14px; border-radius: 50%;
        background: rgba(180, 140, 255, 0.8); cursor: pointer;
        border: none; margin-top: -5.5px;
      }
      .pb-vol-slider::-moz-range-thumb {
        width: 14px; height: 14px; border-radius: 50%;
        background: rgba(180, 140, 255, 0.8); cursor: pointer;
        border: none;
      }
      /* Mobile: compact volume, hide icons */
      @media (max-width: 480px) {
        .pb-vol-label svg { display: none; }
        .pb-vol-slider { width: 34px; }
        .pb-controls-row { gap: 6px; }
        .pb-sep { display: none; }
      }
      /* Landscape mobile: tighter */
      @media (max-height: 440px) {
        .playback-controls { padding-top: 12px; gap: 0; }
        .pb-progress { padding: 6px 0; }
      }
    `;
    document.head.appendChild(style);

    // ── Init slider values ──
    this.el.querySelectorAll<HTMLInputElement>('.pb-vol-slider').forEach(slider => {
      const key = slider.dataset.key!;
      const current = (this.settings.current as unknown as Record<string, number>)[key] ?? 0.5;
      slider.value = String(current);

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        this.settings.updateBatch({ [key]: val } as Partial<Record<string, number>>);
        this.resetHideTimer();
      });
    });

    // ── Events ──
    this.playPauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePause();
      // Haptic feedback on mobile
      if (navigator.vibrate) navigator.vibrate(10);
    });

    // Fullscreen toggle
    this.el.querySelector('.pb-fullscreen')!.addEventListener('click', (e) => {
      e.stopPropagation();
      const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
      } else {
        const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
        (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => {});
      }
      this.resetHideTimer();
    });

    // Exit session
    this.el.querySelector('.pb-exit')!.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._onExit) this._onExit();
    });

    // Progress bar scrubbing
    this.progressBar.addEventListener('mousedown', (e) => { this.dragging = true; this.seekFromMouse(e); });
    document.addEventListener('mousemove', (e) => { if (this.dragging) this.seekFromMouse(e); });
    document.addEventListener('mouseup', () => { this.dragging = false; });

    this.progressBar.addEventListener('touchstart', (e) => { this.dragging = true; this.seekFromTouch(e); }, { passive: true });
    document.addEventListener('touchmove', (e) => { if (this.dragging) this.seekFromTouch(e); }, { passive: true });
    document.addEventListener('touchend', () => { this.dragging = false; });

    // Stop events from reaching canvas
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => e.stopPropagation());
    this.el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

    // Reveal on interaction
    document.addEventListener('mousemove', () => { if (this._active) this.resetHideTimer(); });
    document.addEventListener('touchstart', () => { if (this._active) this.resetHideTimer(); }, { passive: true });

    // Fullscreen change — show controls briefly when entering/exiting
    document.addEventListener('fullscreenchange', () => { if (this._active) this.resetHideTimer(); });
    document.addEventListener('webkitfullscreenchange', () => { if (this._active) this.resetHideTimer(); });
  }

  setNarration(n: NarrationEngine): void { this.narration = n; }
  onExit(fn: () => void): void { this._onExit = fn; }

  togglePause(): void {
    if (this.timeline.paused) {
      this.timeline.resume();
      if (this.narration?.stageAudioElement?.paused) {
        this.narration.stageAudioElement.play().catch(() => {});
      }
      this.audioCompositor.setMasterVolume(
        (this.settings.current as unknown as Record<string, number>).ambientVolume ?? 0.5,
      );
    } else {
      this.timeline.pause();
      if (this.narration?.stageAudioElement && !this.narration.stageAudioElement.paused) {
        this.narration.stageAudioElement.pause();
      }
      this.audioCompositor.setMasterVolume(0);
    }
    this.resetHideTimer();
  }

  activate(): void {
    this._active = true;
    this.el.style.display = 'flex';
    this.el.style.opacity = '1';
    this.resetHideTimer();
  }

  deactivate(): void {
    this._active = false;
    this.el.style.display = 'none';
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  update(): void {
    if (!this._active || !this.timeline.started) return;

    const pos = this.timeline.position;
    const total = this.timeline.totalDuration;
    const pct = total > 0 ? (pos / total) * 100 : 0;

    this.progressFill.style.width = `${pct}%`;
    this.timeLabel.textContent = this.fmt(pos);

    const pauseIcon = this.el.querySelector('.pb-icon-pause') as SVGElement;
    const playIcon = this.el.querySelector('.pb-icon-play') as SVGElement;
    if (this.timeline.paused) {
      pauseIcon.style.display = 'none';
      playIcon.style.display = '';
    } else {
      pauseIcon.style.display = '';
      playIcon.style.display = 'none';
    }
  }

  private resetHideTimer(): void {
    if (!this._active) return;
    this.el.style.display = 'flex';
    this.el.style.opacity = '1';

    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this._active && !this.dragging) {
        this.el.style.opacity = '0';
      }
    }, 4000);
  }

  private seekFromMouse(e: MouseEvent): void {
    const rect = this.progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.timeline.seek(pct * this.timeline.totalDuration);
    if (this.timeline.paused) {
      this.timeline.resume();
      this.audioCompositor.setMasterVolume(
        (this.settings.current as unknown as Record<string, number>).ambientVolume ?? 0.5,
      );
      if (this.narration?.stageAudioElement?.paused) {
        this.narration.stageAudioElement.play().catch(() => {});
      }
    }
    this.resetHideTimer();
  }

  private seekFromTouch(e: TouchEvent): void {
    const touch = e.touches[0];
    if (!touch) return;
    const rect = this.progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    this.timeline.seek(pct * this.timeline.totalDuration);
    if (this.timeline.paused) {
      this.timeline.resume();
      this.audioCompositor.setMasterVolume(
        (this.settings.current as unknown as Record<string, number>).ambientVolume ?? 0.5,
      );
    }
  }

  private fmt(s: number): string {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  destroy(): void {
    this.el.remove();
    if (this.hideTimer) clearTimeout(this.hideTimer);
  }
}
