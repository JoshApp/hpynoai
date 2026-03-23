/**
 * Settings panel — fine-tune the experience.
 * Persisted to localStorage, accessible via gear icon.
 * Toggle: press 's' key or click the gear.
 */

export interface HpynoSettings {
  // Camera
  cameraZ: number;
  cameraFOV: number;
  cameraSway: number;

  // Tunnel
  tunnelSpeed: number;
  spiralSpeedMult: number;
  tunnelWidth: number;        // tunnel radius scale (smaller = narrower)
  breathExpansion: number;     // how much the tunnel breathes (0 = none, 1 = max)

  // Spatial planes — depth layers of the experience
  menuDepth: number;        // selector orbs, titles, prompts
  menuScale: number;        // menu element size multiplier
  narrationStartZ: number;  // where narration text spawns (far)
  narrationEndZ: number;    // where narration text fades (near)
  narrationScale: number;   // narration text size
  interactionDepth: number; // gates, breath-sync, countdowns
  interactionScale: number; // interaction element size multiplier

  // Particles
  particleOpacity: number;
  particleSize: number;

  // Audio
  masterVolume: number;
  narrationVolume: number;
  muted: boolean;

  // Features
  ttsEnabled: boolean;
  micEnabled: boolean;
}

const STORAGE_KEY = 'hpyno-settings';

const DEFAULTS: HpynoSettings = {
  cameraZ: 1,
  cameraFOV: 75,
  cameraSway: 1,
  tunnelSpeed: 1,
  spiralSpeedMult: 1,
  tunnelWidth: 1,
  breathExpansion: 1,
  menuDepth: -1.5,
  menuScale: 1,
  narrationStartZ: -3,
  narrationEndZ: -0.3,
  narrationScale: 1,
  interactionDepth: -1.2,
  interactionScale: 1,
  particleOpacity: 1,
  particleSize: 1,
  masterVolume: 1,
  narrationVolume: 0.8,
  muted: false,
  ttsEnabled: true,
  micEnabled: true,
};

type SettingsListener = (settings: HpynoSettings) => void;

export class SettingsManager {
  private settings: HpynoSettings;
  private listeners: SettingsListener[] = [];
  private panel: HTMLDivElement;
  private muteBtn: HTMLButtonElement;
  private visible = false;
  private calibrateHandler: (() => void) | null = null;
  private sliderDefs: Array<{ key: keyof HpynoSettings; unit?: string }> = [];

  constructor() {
    this.settings = this.load();
    this.panel = this.createPanel();
    this.muteBtn = this.createMuteButton();
    document.body.appendChild(this.panel);
    document.body.appendChild(this.muteBtn);
    this.bindKeys();
    this.updateMuteButton();
  }

  get current(): Readonly<HpynoSettings> {
    return this.settings;
  }

  onChange(listener: SettingsListener): void {
    this.listeners.push(listener);
  }

  private load(): HpynoSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...parsed };
      }
    } catch { /* ignore */ }
    return { ...DEFAULTS };
  }

  private save(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    this.listeners.forEach(fn => fn(this.settings));
  }

  private update(key: keyof HpynoSettings, value: number | boolean): void {
    (this.settings as unknown as Record<string, unknown>)[key] = value;
    this.save();
  }

  /** Update multiple settings at once (single save + notify) */
  updateBatch(changes: Partial<HpynoSettings>): void {
    Object.assign(this.settings, changes);
    this.save();
    this.updateMuteButton();
    this.refreshPanel();
  }

  /** Set callback for the calibrate button */
  onCalibrate(handler: () => void): void {
    this.calibrateHandler = handler;
  }

  /** Refresh all panel UI to match current settings */
  private refreshPanel(): void {
    for (const s of this.sliderDefs) {
      const input = this.panel.querySelector<HTMLInputElement>(`#settings-${s.key}`);
      const valEl = this.panel.querySelector<HTMLSpanElement>(`#settings-${s.key}-val`);
      if (input) input.value = String(this.settings[s.key]);
      if (valEl) valEl.textContent = this.formatVal(this.settings[s.key] as number, s.unit);
    }
    const muteCheck = this.panel.querySelector<HTMLInputElement>('#settings-muted');
    if (muteCheck) muteCheck.checked = this.settings.muted;
    const ttsCheck = this.panel.querySelector<HTMLInputElement>('#settings-ttsEnabled');
    if (ttsCheck) ttsCheck.checked = this.settings.ttsEnabled;
    const micCheck = this.panel.querySelector<HTMLInputElement>('#settings-micEnabled');
    if (micCheck) micCheck.checked = this.settings.micEnabled;
  }

  toggleMute(): void {
    this.settings.muted = !this.settings.muted;
    this.save();
    this.updateMuteButton();
    // Update panel slider if visible
    const muteCheck = this.panel.querySelector<HTMLInputElement>('#settings-muted');
    if (muteCheck) muteCheck.checked = this.settings.muted;
  }

  private updateMuteButton(): void {
    this.muteBtn.textContent = this.settings.muted ? '\u{1F507}' : '\u{1F50A}';
    this.muteBtn.title = this.settings.muted ? 'Unmute' : 'Mute';
  }

  private createMuteButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = 'settings-mute-btn';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMute();
    });
    return btn;
  }

  private createPanel(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'settings-panel';

    const sliders: Array<{
      key: keyof HpynoSettings;
      label: string;
      min: number;
      max: number;
      step: number;
      unit?: string;
      group: string;
    }> = [
      { key: 'cameraZ', label: 'camera distance', min: 0.1, max: 10, step: 0.05, group: 'camera' },
      { key: 'cameraFOV', label: 'field of view', min: 20, max: 160, step: 1, unit: '\u00B0', group: 'camera' },
      { key: 'cameraSway', label: 'camera sway', min: 0, max: 10, step: 0.1, unit: 'x', group: 'camera' },
      { key: 'tunnelSpeed', label: 'tunnel speed', min: 0, max: 5, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'spiralSpeedMult', label: 'spiral speed', min: 0, max: 5, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'tunnelWidth', label: 'tunnel width', min: 0.3, max: 3, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'breathExpansion', label: 'breath expansion', min: 0, max: 2, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'menuDepth', label: 'menu depth', min: -20, max: -0.1, step: 0.1, group: 'spatial' },
      { key: 'menuScale', label: 'menu size', min: 0.1, max: 10, step: 0.1, unit: 'x', group: 'spatial' },
      { key: 'narrationStartZ', label: 'narration appear', min: -20, max: -0.1, step: 0.1, group: 'spatial' },
      { key: 'narrationEndZ', label: 'narration fade', min: -5, max: 5, step: 0.05, group: 'spatial' },
      { key: 'narrationScale', label: 'narration size', min: 0.1, max: 10, step: 0.1, unit: 'x', group: 'spatial' },
      { key: 'interactionDepth', label: 'interaction depth', min: -20, max: -0.1, step: 0.1, group: 'spatial' },
      { key: 'interactionScale', label: 'interaction size', min: 0.1, max: 10, step: 0.1, unit: 'x', group: 'spatial' },
      { key: 'particleOpacity', label: 'particle brightness', min: 0, max: 5, step: 0.1, unit: 'x', group: 'particles' },
      { key: 'particleSize', label: 'particle size', min: 0, max: 10, step: 0.1, unit: 'x', group: 'particles' },
      { key: 'masterVolume', label: 'master volume', min: 0, max: 2, step: 0.05, group: 'audio' },
      { key: 'narrationVolume', label: 'narration volume', min: 0, max: 1.5, step: 0.05, group: 'audio' },
    ];

    // Store slider defs for refreshPanel
    this.sliderDefs = sliders.map(s => ({ key: s.key, unit: s.unit }));

    const groups = ['camera', 'tunnel', 'spatial', 'particles', 'audio'];

    let html = `
      <div class="settings-header">
        <span>SETTINGS</span>
        <button id="settings-close">\u00D7</button>
      </div>
      <div class="settings-body">
        ${groups.map(g => `
          <div class="settings-group">
            <div class="settings-group-title">${g}</div>
            ${g === 'audio' ? `
              <div class="settings-row settings-toggle-row">
                <label>muted</label>
                <input type="checkbox" id="settings-muted" ${this.settings.muted ? 'checked' : ''} />
              </div>
            ` : ''}
            ${sliders.filter(s => s.group === g).map(s => this.sliderHTML(s)).join('')}
          </div>
        `).join('')}
        <div class="settings-group">
          <div class="settings-group-title">features</div>
          <div class="settings-row settings-toggle-row">
            <label>text-to-speech narration</label>
            <input type="checkbox" id="settings-ttsEnabled" ${this.settings.ttsEnabled ? 'checked' : ''} />
          </div>
          <div class="settings-row settings-toggle-row">
            <label>microphone (breath detect)</label>
            <input type="checkbox" id="settings-micEnabled" ${this.settings.micEnabled ? 'checked' : ''} />
          </div>
        </div>
        <div class="settings-group">
          <button id="settings-calibrate" class="settings-btn-calibrate">calibrate experience</button>
        </div>
        <div class="settings-group">
          <button id="settings-reset" class="settings-btn-reset">reset to defaults</button>
          <button id="settings-reset-calibration" class="settings-btn-reset">reset auto-calibration</button>
        </div>
      </div>
    `;

    panel.innerHTML = html;

    // Stop all pointer events from leaking through to the canvas/raycaster
    // This is what makes sliders draggable — without it, mousedown on a slider
    // bubbles to the canvas and the browser never enters drag mode on the thumb.
    for (const evt of ['mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup'] as const) {
      panel.addEventListener(evt, (e) => e.stopPropagation());
    }

    // Bind slider events after DOM is set
    requestAnimationFrame(() => {
      sliders.forEach(s => {
        const input = panel.querySelector<HTMLInputElement>(`#settings-${s.key}`);
        const valEl = panel.querySelector<HTMLSpanElement>(`#settings-${s.key}-val`);
        if (!input || !valEl) return;
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          this.update(s.key, v);
          valEl.textContent = this.formatVal(v, s.unit);
        });
      });

      panel.querySelector('#settings-close')!.addEventListener('click', () => this.hide());

      panel.querySelector<HTMLInputElement>('#settings-muted')!.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        this.settings.muted = checked;
        this.save();
        this.updateMuteButton();
      });

      // Feature toggles
      for (const key of ['ttsEnabled', 'micEnabled'] as const) {
        panel.querySelector<HTMLInputElement>(`#settings-${key}`)!.addEventListener('change', (e) => {
          this.update(key, (e.target as HTMLInputElement).checked);
        });
      }

      panel.querySelector('#settings-reset')!.addEventListener('click', () => {
        this.settings = { ...DEFAULTS };
        this.save();
        this.updateMuteButton();
        this.refreshPanel();
      });

      panel.querySelector('#settings-calibrate')!.addEventListener('click', () => {
        if (this.calibrateHandler) this.calibrateHandler();
      });

      panel.querySelector('#settings-reset-calibration')!.addEventListener('click', () => {
        localStorage.removeItem('hpyno-calibrated');
        this.settings = { ...DEFAULTS };
        this.save();
        this.updateMuteButton();
        this.refreshPanel();
      });
    });

    return panel;
  }

  private sliderHTML(s: { key: keyof HpynoSettings; label: string; min: number; max: number; step: number; unit?: string }): string {
    const val = this.settings[s.key] as number;
    return `
      <div class="settings-row">
        <label>${s.label}</label>
        <div class="settings-slider-wrap">
          <input type="range" id="settings-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${val}" />
          <span id="settings-${s.key}-val" class="settings-val">${this.formatVal(val, s.unit)}</span>
        </div>
      </div>
    `;
  }

  private formatVal(v: number, unit?: string): string {
    const str = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
    return str + (unit ?? '');
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Don't trigger if typing in an input
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        e.preventDefault();
        this.visible ? this.hide() : this.show();
      }
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        this.toggleMute();
      }
    });
  }

  show(): void {
    this.visible = true;
    this.panel.classList.add('visible');
    document.body.style.cursor = 'default';
  }

  hide(): void {
    this.visible = false;
    this.panel.classList.remove('visible');
    document.body.style.cursor = 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }
}
