/**
 * HUD — manages all overlay UI elements.
 *
 * Screens call hud.setMode('session') or hud.setMode('menu') to show/hide
 * the right set of controls. Individual elements are still self-contained
 * classes — the HUD just coordinates which are visible.
 *
 * Modes:
 *   'menu'    — settings gear, mute, fullscreen buttons visible. Playback hidden.
 *   'session' — playback controls visible. Floating buttons hidden (playback has fullscreen + exit).
 *   'clean'   — everything hidden (for cinematic moments, loading).
 */

import type { PlaybackControls } from './playback-controls';
import type { SettingsManager } from './settings';
import type { Timebar } from './timebar';
import type { DevMode } from './devmode';

export type HudMode = 'menu' | 'session' | 'clean';

export class HUD {
  private playbackControls: PlaybackControls;
  private settings: SettingsManager;
  private timebar: Timebar;
  private devMode: DevMode;
  private fsBtn: HTMLButtonElement;
  private _mode: HudMode = 'menu';

  constructor(opts: {
    playbackControls: PlaybackControls;
    settings: SettingsManager;
    timebar: Timebar;
    devMode: DevMode;
    fsBtn: HTMLButtonElement;
  }) {
    this.playbackControls = opts.playbackControls;
    this.settings = opts.settings;
    this.timebar = opts.timebar;
    this.devMode = opts.devMode;
    this.fsBtn = opts.fsBtn;
  }

  get mode(): HudMode { return this._mode; }

  setMode(mode: HudMode): void {
    this._mode = mode;

    switch (mode) {
      case 'menu':
        this.playbackControls.deactivate();
        this.settings.setButtonVisibility(true);
        this.fsBtn.style.display = '';
        break;

      case 'session':
        this.playbackControls.activate();
        // Hide floating buttons — playback controls has fullscreen + exit
        this.settings.setButtonVisibility(false);
        this.fsBtn.style.display = 'none';
        break;

      case 'clean':
        this.playbackControls.deactivate();
        this.settings.setButtonVisibility(false);
        this.fsBtn.style.display = 'none';
        break;
    }
  }

  /** Call every render frame */
  update(): void {
    if (this._mode === 'session') {
      this.playbackControls.update();
    }
  }

  destroy(): void {
    this.playbackControls.destroy();
  }
}
