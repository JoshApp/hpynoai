/**
 * Playback controls — minimal, sleek play/pause + progress bar.
 * Visible during sessions unless in fullscreen mode.
 * Floats at the bottom, fades on inactivity.
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
  private visible = false;
  private dragging = false;
  private hideTimer: number | null = null;
  private _active = false;

  constructor(timeline: Timeline, settings: SettingsManager, audioCompositor: AudioCompositor) {
    this.timeline = timeline;
    this.settings = settings;
    this.audioCompositor = audioCompositor;

    this.el = document.createElement('div');
    this.el.className = 'playback-controls';
    this.el.innerHTML = `
      <button class="pb-playpause" aria-label="Play/Pause">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path class="pb-icon-pause" d="M6 4h4v16H6zM14 4h4v16h-4z"/>
          <path class="pb-icon-play" d="M8 5v14l11-7z" style="display:none"/>
        </svg>
      </button>
      <div class="pb-progress">
        <div class="pb-progress-fill"></div>
      </div>
      <span class="pb-time">0:00</span>
      <div class="pb-divider"></div>
      <div class="pb-vol-group">
        <label class="pb-vol-label" title="Ambient">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" opacity="0.5">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
          </svg>
          <input type="range" class="pb-vol-slider" data-key="ambientVolume" min="0" max="1.5" step="0.05">
        </label>
        <label class="pb-vol-label" title="Binaural">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" opacity="0.5">
            <path d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7zm0-12c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3z"/>
          </svg>
          <input type="range" class="pb-vol-slider" data-key="binauralVolume" min="0" max="1" step="0.05">
        </label>
        <label class="pb-vol-label" title="Narration">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" opacity="0.5">
            <path d="M9 13c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0-6c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm0 8c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
          </svg>
          <input type="range" class="pb-vol-slider" data-key="narrationVolume" min="0" max="1.5" step="0.05">
        </label>
      </div>
    `;

    // Style
    this.el.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      display: none; align-items: center; gap: 12px;
      background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px; padding: 8px 16px;
      font: 12px -apple-system, sans-serif; color: rgba(255, 255, 255, 0.7);
      z-index: 1000; user-select: none;
      transition: opacity 0.5s ease;
      pointer-events: auto;
      cursor: default;
    `;

    document.body.appendChild(this.el);

    this.playPauseBtn = this.el.querySelector('.pb-playpause')!;
    this.progressBar = this.el.querySelector('.pb-progress')!;
    this.progressFill = this.el.querySelector('.pb-progress-fill')!;
    this.timeLabel = this.el.querySelector('.pb-time')!;

    // Button style
    this.playPauseBtn.style.cssText = `
      background: none; border: none; color: rgba(255, 255, 255, 0.8);
      cursor: pointer; padding: 4px; display: flex; align-items: center;
      border-radius: 50%; transition: background 0.2s;
    `;

    // Progress bar style
    this.progressBar.style.cssText = `
      width: 120px; height: 4px; background: rgba(255, 255, 255, 0.15);
      border-radius: 2px; cursor: pointer; position: relative;
    `;

    this.progressFill.style.cssText = `
      height: 100%; background: rgba(180, 140, 255, 0.6);
      border-radius: 2px; width: 0%; transition: width 0.1s linear;
    `;

    this.timeLabel.style.cssText = `
      min-width: 36px; text-align: right; font-variant-numeric: tabular-nums;
      font-size: 11px; opacity: 0.6;
    `;

    // Divider
    const divider = this.el.querySelector('.pb-divider') as HTMLDivElement;
    divider.style.cssText = `
      width: 1px; height: 16px; background: rgba(255,255,255,0.12); flex-shrink: 0;
    `;

    // Volume group
    const volGroup = this.el.querySelector('.pb-vol-group') as HTMLDivElement;
    volGroup.style.cssText = `
      display: flex; align-items: center; gap: 8px;
    `;

    // Volume labels + sliders
    this.el.querySelectorAll<HTMLLabelElement>('.pb-vol-label').forEach(label => {
      label.style.cssText = `
        display: flex; align-items: center; gap: 4px; cursor: pointer;
      `;
    });

    this.el.querySelectorAll<HTMLInputElement>('.pb-vol-slider').forEach(slider => {
      slider.style.cssText = `
        -webkit-appearance: none; appearance: none;
        width: 50px; height: 3px; border-radius: 2px;
        background: rgba(255,255,255,0.15); outline: none;
        cursor: pointer;
      `;

      // Style the thumb via a <style> tag (can't do inline for pseudo-elements)
      const key = slider.dataset.key!;
      const current = (this.settings.current as unknown as Record<string, number>)[key] ?? 0.5;
      slider.value = String(current);

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        this.settings.updateBatch({ [key]: val } as Partial<Record<string, number>>);
        this.resetHideTimer();
      });
    });

    // Add custom slider thumb styles
    const style = document.createElement('style');
    style.textContent = `
      .pb-vol-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 10px; height: 10px; border-radius: 50%;
        background: rgba(180, 140, 255, 0.8); cursor: pointer;
        border: none; margin-top: -3.5px;
      }
      .pb-vol-slider::-moz-range-thumb {
        width: 10px; height: 10px; border-radius: 50%;
        background: rgba(180, 140, 255, 0.8); cursor: pointer;
        border: none;
      }
      .pb-vol-slider::-webkit-slider-runnable-track {
        height: 3px; border-radius: 2px;
      }
    `;
    document.head.appendChild(style);

    // Events
    this.playPauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePause();
      this.resetHideTimer();
    });

    this.progressBar.addEventListener('mousedown', (e) => { this.dragging = true; this.seekFromMouse(e); });
    document.addEventListener('mousemove', (e) => { if (this.dragging) this.seekFromMouse(e); });
    document.addEventListener('mouseup', () => { this.dragging = false; });

    // Touch support
    this.progressBar.addEventListener('touchstart', (e) => { this.dragging = true; this.seekFromTouch(e); }, { passive: true });
    document.addEventListener('touchmove', (e) => { if (this.dragging) this.seekFromTouch(e); }, { passive: true });
    document.addEventListener('touchend', () => { this.dragging = false; });

    // Stop events from reaching canvas
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => e.stopPropagation());
    this.el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

    // Show on mouse movement, auto-hide after 3s
    document.addEventListener('mousemove', () => this.resetHideTimer());
    document.addEventListener('touchstart', () => this.resetHideTimer(), { passive: true });

    // Hide in fullscreen
    document.addEventListener('fullscreenchange', () => this.updateVisibility());
    document.addEventListener('webkitfullscreenchange', () => this.updateVisibility());
  }

  setNarration(n: NarrationEngine): void { this.narration = n; }

  togglePause(): void {
    if (this.timeline.paused) {
      this.timeline.resume();
      // Resume narration audio
      if (this.narration?.stageAudioElement?.paused) {
        this.narration.stageAudioElement.play().catch(() => {});
      }
      // Resume ambient
      this.audioCompositor.setMasterVolume(
        (this.settings.current as unknown as Record<string, number>).ambientVolume ?? 0.5,
      );
    } else {
      this.timeline.pause();
      // Pause narration audio
      if (this.narration?.stageAudioElement && !this.narration.stageAudioElement.paused) {
        this.narration.stageAudioElement.pause();
      }
      // Mute ambient (not dispose — just silent)
      this.audioCompositor.setMasterVolume(0);
    }
    this.resetHideTimer();
  }

  /** Show the controls (call when session starts) */
  activate(): void {
    this._active = true;
    this.updateVisibility();
    this.resetHideTimer();
  }

  /** Hide the controls (call when session ends) */
  deactivate(): void {
    this._active = false;
    this.el.style.display = 'none';
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
  }

  /** Update every render frame */
  update(): void {
    if (!this._active || !this.timeline.started) return;

    const pos = this.timeline.position;
    const total = this.timeline.totalDuration;
    const pct = total > 0 ? (pos / total) * 100 : 0;

    this.progressFill.style.width = `${pct}%`;
    this.timeLabel.textContent = this.fmt(pos);

    // Update play/pause icon
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

  private updateVisibility(): void {
    if (!this._active) return;
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const isFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
    this.el.style.display = isFs ? 'none' : 'flex';
  }

  private resetHideTimer(): void {
    if (!this._active) return;
    this.updateVisibility();
    this.el.style.opacity = '1';

    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this._active && !this.dragging) {
        this.el.style.opacity = '0.15';
      }
    }, 4000);
  }

  private seekFromMouse(e: MouseEvent): void {
    const rect = this.progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.timeline.seek(pct * this.timeline.totalDuration);
    // Auto-resume after scrub if was paused
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
