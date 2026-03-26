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
  ambientVolume: number;
  binauralVolume: number;
  breathClipVolume: number;
  muted: boolean;

  // Visual level
  // 'minimal' = dark gradient, presence + text only (accessibility)
  // 'calm'    = slow tunnel, no feedback warp, reduced effects
  // 'full'    = everything enabled (default)
  // 'intense' = stronger effects, more feedback, faster spiral
  visualLevel: 'minimal' | 'calm' | 'full' | 'intense';

  // Experience level
  // 'listen' = audio + text only
  // 'watch' = + gates/prompts
  // 'breathe' = + breath sync interaction
  // 'immerse' = + mic/voice detection
  experienceLevel: 'listen' | 'watch' | 'breathe' | 'immerse';

  // Features
  ttsEnabled: boolean;
  micEnabled: boolean;

  // API Keys
  sunoApiKey: string;
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
  menuScale: 2.5,
  narrationStartZ: -1.8,
  narrationEndZ: -0.55,
  narrationScale: 1.4,
  interactionDepth: -1.2,
  interactionScale: 1.2,
  particleOpacity: 1,
  particleSize: 1,
  masterVolume: 1,
  narrationVolume: 0.8,
  ambientVolume: 0.7,
  binauralVolume: 0.7,
  breathClipVolume: 0.7,
  muted: false,
  visualLevel: 'full' as const,
  experienceLevel: 'watch' as const,
  ttsEnabled: true,
  micEnabled: false,
  sunoApiKey: '',
};

type SettingsListener = (settings: HpynoSettings) => void;

export class SettingsManager {
  private settings: HpynoSettings;
  private listeners: SettingsListener[] = [];
  private panel: HTMLDivElement;
  private muteBtn: HTMLButtonElement;
  private gearBtn: HTMLButtonElement;
  private visible = false;
  private calibrateHandler: (() => void) | null = null;
  private sliderDefs: Array<{ key: keyof HpynoSettings; unit?: string }> = [];

  constructor() {
    this.settings = this.load();
    this.panel = this.createPanel();
    this.muteBtn = this.createMuteButton();
    this.gearBtn = this.createGearButton();
    document.body.appendChild(this.panel);
    document.body.appendChild(this.muteBtn);
    document.body.appendChild(this.gearBtn);
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
    // Level pickers
    this.refreshLevelPicker('settings-visualLevel', this.settings.visualLevel, ['minimal', 'calm', 'full', 'intense']);
    this.refreshLevelPicker('settings-experienceLevel', this.settings.experienceLevel, ['listen', 'watch', 'breathe', 'immerse']);
  }

  private refreshLevelPicker(containerId: string, current: string, levels: string[]): void {
    const container = this.panel.querySelector(`#${containerId}`);
    if (!container) return;
    const selectedIdx = levels.indexOf(current);
    container.querySelectorAll<HTMLButtonElement>('.settings-level-btn').forEach(b => {
      const idx = levels.indexOf(b.dataset.level!);
      b.classList.toggle('active', idx === selectedIdx);
      b.classList.toggle('included', idx < selectedIdx);
    });
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

  private createGearButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = 'settings-gear-btn';
    btn.textContent = '\u2699';
    btn.title = 'Settings';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.visible ? this.hide() : this.show();
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
      { key: 'cameraSway', label: 'camera sway', min: 0, max: 3, step: 0.1, unit: 'x', group: 'camera' },
      { key: 'tunnelSpeed', label: 'tunnel speed', min: 0, max: 5, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'spiralSpeedMult', label: 'spiral speed', min: 0, max: 5, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'tunnelWidth', label: 'tunnel width', min: 0.3, max: 3, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'breathExpansion', label: 'breath expansion', min: 0, max: 2, step: 0.05, unit: 'x', group: 'tunnel' },
      { key: 'menuDepth', label: 'menu depth', min: -5, max: -0.5, step: 0.1, group: 'spatial' },
      { key: 'menuScale', label: 'menu size', min: 0.5, max: 5, step: 0.1, unit: 'x', group: 'spatial' },
      { key: 'narrationStartZ', label: 'narration appear', min: -5, max: -0.5, step: 0.1, group: 'spatial' },
      { key: 'narrationEndZ', label: 'narration fade', min: -2, max: -0.1, step: 0.05, group: 'spatial' },
      { key: 'narrationScale', label: 'narration size', min: 0.5, max: 5, step: 0.1, unit: 'x', group: 'spatial' },
      { key: 'interactionDepth', label: 'interaction depth', min: -5, max: -0.3, step: 0.1, group: 'spatial' },
      { key: 'interactionScale', label: 'interaction size', min: 0.5, max: 4, step: 0.1, unit: 'x', group: 'spatial' },
      { key: 'particleOpacity', label: 'particle brightness', min: 0, max: 3, step: 0.1, unit: 'x', group: 'particles' },
      { key: 'particleSize', label: 'particle size', min: 0, max: 5, step: 0.1, unit: 'x', group: 'particles' },
      { key: 'masterVolume', label: 'master volume', min: 0, max: 2, step: 0.05, group: 'audio' },
      { key: 'narrationVolume', label: 'narration volume', min: 0, max: 1.5, step: 0.05, group: 'audio' },
      { key: 'ambientVolume', label: 'ambient volume', min: 0, max: 1.5, step: 0.05, group: 'audio' },
      { key: 'binauralVolume', label: 'binaural volume', min: 0, max: 1, step: 0.05, group: 'audio' },
      { key: 'breathClipVolume', label: 'breath cue volume', min: 0, max: 1, step: 0.05, group: 'audio' },
    ];

    // Store slider defs for refreshPanel
    this.sliderDefs = sliders.map(s => ({ key: s.key, unit: s.unit }));

    // Quick settings = audio + experience/visual level
    const quickSliders = sliders.filter(s => s.group === 'audio');
    const advancedGroups = ['camera', 'tunnel', 'spatial', 'particles'];

    let html = `
      <div class="settings-header">
        <span>settings</span>
        <button id="settings-close">\u00D7</button>
      </div>
      <div class="settings-body">
        <!-- Quick settings: always visible -->
        <div class="settings-section settings-quick">
          <div class="settings-group">
            <div class="settings-row settings-toggle-row">
              <label>muted</label>
              <input type="checkbox" id="settings-muted" ${this.settings.muted ? 'checked' : ''} />
            </div>
            ${quickSliders.map(s => this.sliderHTML(s)).join('')}
          </div>
        <!-- Advanced settings: collapsed by default -->
        <div class="settings-section settings-advanced" style="display: none;">
          <button class="settings-advanced-toggle" id="settings-toggle-advanced" style="display: none;">
            ▸ advanced settings
          </button>
        <div class="settings-group">
          <div class="settings-group-title">visual level</div>
          <div class="settings-level-picker" id="settings-visualLevel">
            <button class="settings-level-btn ${this.settings.visualLevel === 'minimal' ? 'active' : ''}" data-level="minimal">
              <span class="level-name">minimal</span>
              <span class="level-features">dark bg, presence + text</span>
            </button>
            <button class="settings-level-btn ${this.settings.visualLevel === 'calm' ? 'active' : ''}" data-level="calm">
              <span class="level-name">calm</span>
              <span class="level-features">slow tunnel, soft effects</span>
            </button>
            <button class="settings-level-btn ${this.settings.visualLevel === 'full' ? 'active' : ''}" data-level="full">
              <span class="level-name">full</span>
              <span class="level-features">everything enabled</span>
            </button>
            <button class="settings-level-btn ${this.settings.visualLevel === 'intense' ? 'active' : ''}" data-level="intense">
              <span class="level-name">intense</span>
              <span class="level-features">stronger effects</span>
            </button>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">experience level</div>
          <div class="settings-level-picker" id="settings-experienceLevel">
            <button class="settings-level-btn ${this.settings.experienceLevel === 'listen' ? 'active' : ''}" data-level="listen">
              <span class="level-name">🎧 listen</span>
              <span class="level-features">audio + visuals</span>
            </button>
            <button class="settings-level-btn ${this.settings.experienceLevel === 'watch' ? 'active' : ''}" data-level="watch">
              <span class="level-name">👁 watch</span>
              <span class="level-features">+ prompts &amp; gates</span>
            </button>
            <button class="settings-level-btn ${this.settings.experienceLevel === 'breathe' ? 'active' : ''}" data-level="breathe">
              <span class="level-name">🫁 breathe</span>
              <span class="level-features">+ breathing sync</span>
            </button>
            <button class="settings-level-btn ${this.settings.experienceLevel === 'immerse' ? 'active' : ''}" data-level="immerse">
              <span class="level-name">🎤 immerse</span>
              <span class="level-features">+ mic &amp; voice</span>
            </button>
          </div>
        </div>
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
        ${advancedGroups.map(g => `
          <div class="settings-group">
            <div class="settings-group-title">${g}</div>
            ${sliders.filter(s => s.group === g).map(s => this.sliderHTML(s)).join('')}
          </div>
        `).join('')}
        <div class="settings-group">
          <button id="settings-reset" class="settings-btn-reset">reset to defaults</button>
          <button id="settings-reset-calibration" class="settings-btn-reset">reset auto-calibration</button>
        </div>
        </div><!-- end advanced section -->
      </div>
    `;

    // Add the advanced toggle button BEFORE the advanced section (outside it, after quick)
    // This gets wired up in the event binding below

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

      // Advanced toggle
      const advSection = panel.querySelector('.settings-advanced') as HTMLDivElement;
      const advToggle = panel.querySelector('#settings-toggle-advanced') as HTMLButtonElement;
      if (advSection && advToggle) {
        // Move the toggle out of the hidden section so it's always visible
        advSection.parentElement?.insertBefore(advToggle, advSection);
        advToggle.style.display = '';
        advToggle.addEventListener('click', () => {
          const visible = advSection.style.display !== 'none';
          advSection.style.display = visible ? 'none' : '';
          advToggle.textContent = visible ? '▸ advanced settings' : '▾ advanced settings';
        });
      }

      panel.querySelector<HTMLInputElement>('#settings-muted')!.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        this.settings.muted = checked;
        this.save();
        this.updateMuteButton();
      });

      // Visual level buttons
      this.bindLevelPicker(panel, 'settings-visualLevel', 'visualLevel',
        ['minimal', 'calm', 'full', 'intense']);

      // Experience level buttons
      this.bindLevelPicker(panel, 'settings-experienceLevel', 'experienceLevel',
        ['listen', 'watch', 'breathe', 'immerse']);

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
        localStorage.removeItem('hpyno-calibrated-v2');
        localStorage.removeItem('hpyno-level-set');
        this.settings = { ...DEFAULTS };
        this.save();
        this.updateMuteButton();
        this.refreshPanel();
      });
    });

    return panel;
  }

  private bindLevelPicker(panel: HTMLElement, containerId: string, settingsKey: string, levels: string[]): void {
    const container = panel.querySelector(`#${containerId}`);
    if (!container) return;
    container.querySelectorAll<HTMLButtonElement>('.settings-level-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const level = btn.dataset.level!;
        (this.settings as unknown as Record<string, unknown>)[settingsKey] = level;
        this.save();
        this.listeners.forEach(fn => fn(this.settings));
        const selectedIdx = levels.indexOf(level);
        container.querySelectorAll<HTMLButtonElement>('.settings-level-btn').forEach(b => {
          const idx = levels.indexOf(b.dataset.level!);
          b.classList.toggle('active', idx === selectedIdx);
          b.classList.toggle('included', idx < selectedIdx);
        });
      });
    });
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

  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private bindKeys(): void {
    this.keyHandler = (e) => {
      // Settings toggle: comma key (S is used by WASD navigation, gear icon is the primary toggle)
      if (e.key === ',' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        e.preventDefault();
        this.visible ? this.hide() : this.show();
      }
      if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        this.toggleMute();
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  show(): void {
    this.visible = true;
    this.panel.classList.add('visible');
    if (window.matchMedia('(pointer: fine)').matches) {
      document.body.style.cursor = 'default';
    }
  }

  hide(): void {
    this.visible = false;
    this.panel.classList.remove('visible');
    if (window.matchMedia('(pointer: fine)').matches) {
      document.body.style.cursor = 'none';
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Show/hide the floating mute + gear buttons */
  setButtonVisibility(visible: boolean): void {
    const display = visible ? '' : 'none';
    this.muteBtn.style.display = display;
    this.gearBtn.style.display = display;
  }

  destroy(): void {
    this.panel.remove();
    this.muteBtn.remove();
    this.gearBtn.remove();
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    this.listeners = [];
  }
}
