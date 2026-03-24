/**
 * Settings panel — fine-tune the experience.
 * Persisted to localStorage, accessible via gear icon.
 * Toggle: press 's' key or click the gear.
 */

import { hotState, type AuthState } from './hot-state';
import { openPortal, startCheckout } from './payments';

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
  muted: false,
  visualLevel: 'full' as const,
  experienceLevel: 'watch' as const,
  ttsEnabled: true,
  micEnabled: false,
  sunoApiKey: '',
};

type SettingsListener = (settings: HpynoSettings) => void;

/** Minimal entitlement check interface for settings panel gating. */
export interface SettingsEntitlementChecker {
  canAccessLevel(level: string): boolean;
  canAccessFeature(feature: string): boolean;
  onChange(listener: () => void): () => void;
}

export class SettingsManager {
  private settings: HpynoSettings;
  private listeners: SettingsListener[] = [];
  private panel: HTMLDivElement;
  private muteBtn: HTMLButtonElement;
  private gearBtn: HTMLButtonElement;
  private visible = false;
  private calibrateHandler: (() => void) | null = null;
  private sliderDefs: Array<{ key: keyof HpynoSettings; unit?: string }> = [];
  private authUnsub: (() => void) | null = null;
  private accessTokenProvider: (() => string | null) | null = null;
  private entitlements: SettingsEntitlementChecker | null = null;
  private upgradeHandler: ((feature: string) => void) | null = null;

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
    this.bindAuthSection();
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

  /** Set entitlement checker for content gating in the panel. */
  setEntitlements(checker: SettingsEntitlementChecker, onUpgrade: (feature: string) => void): void {
    this.entitlements = checker;
    this.upgradeHandler = onUpgrade;
    checker.onChange(() => this.refreshGating());
    this.refreshGating();
  }

  /** Set callback for the calibrate button */
  onCalibrate(handler: () => void): void {
    this.calibrateHandler = handler;
  }

  /** Set provider for the current user's Supabase access token */
  setAccessTokenProvider(provider: () => string | null): void {
    this.accessTokenProvider = provider;
  }

  private getAccessToken(): string | null {
    return this.accessTokenProvider ? this.accessTokenProvider() : null;
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

  /** Update lock icons on experience level buttons and feature toggles. */
  private refreshGating(): void {
    if (!this.entitlements) return;
    // Experience level lock icons
    const expContainer = this.panel.querySelector('#settings-experienceLevel');
    if (expContainer) {
      expContainer.querySelectorAll<HTMLButtonElement>('.settings-level-btn').forEach(btn => {
        const level = btn.dataset.level!;
        const locked = !this.entitlements!.canAccessLevel(level);
        btn.classList.toggle('locked', locked);
        // Add/remove lock indicator
        let lockEl = btn.querySelector('.lock-icon');
        if (locked && !lockEl) {
          lockEl = document.createElement('span');
          lockEl.className = 'lock-icon';
          lockEl.textContent = '\u{1F512}';
          btn.appendChild(lockEl);
        } else if (!locked && lockEl) {
          lockEl.remove();
        }
      });
    }
    // Mic feature lock
    const micCheck = this.panel.querySelector<HTMLInputElement>('#settings-micEnabled');
    if (micCheck) {
      const micLocked = !this.entitlements.canAccessFeature('mic');
      const row = micCheck.closest('.settings-toggle-row');
      if (row) {
        row.classList.toggle('locked', micLocked);
        let lockEl = row.querySelector('.lock-icon');
        if (micLocked && !lockEl) {
          lockEl = document.createElement('span');
          lockEl.className = 'lock-icon';
          lockEl.textContent = '\u{1F512}';
          row.querySelector('label')?.appendChild(lockEl);
        } else if (!micLocked && lockEl) {
          lockEl.remove();
        }
      }
    }
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
        <div class="settings-group" id="settings-account-section" style="display:none">
          <div class="settings-group-title">account</div>
          <div id="settings-account-content"></div>
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
        <div class="settings-group" id="settings-subscription-section" style="display:none">
          <div class="settings-group-title">subscription</div>
          <button id="settings-upgrade" class="settings-btn-calibrate">upgrade to premium</button>
          <button id="settings-manage-sub" class="settings-btn-reset">manage subscription</button>
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

      // Visual level buttons
      this.bindLevelPicker(panel, 'settings-visualLevel', 'visualLevel',
        ['minimal', 'calm', 'full', 'intense']);

      // Experience level buttons
      this.bindLevelPicker(panel, 'settings-experienceLevel', 'experienceLevel',
        ['listen', 'watch', 'breathe', 'immerse']);

      // Feature toggles
      for (const key of ['ttsEnabled', 'micEnabled'] as const) {
        panel.querySelector<HTMLInputElement>(`#settings-${key}`)!.addEventListener('change', (e) => {
          const checkbox = e.target as HTMLInputElement;
          // Gate mic behind entitlements
          if (key === 'micEnabled' && checkbox.checked && this.entitlements && !this.entitlements.canAccessFeature('mic')) {
            checkbox.checked = false;
            if (this.upgradeHandler) this.upgradeHandler('feature:mic');
            return;
          }
          this.update(key, checkbox.checked);
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

      panel.querySelector('#settings-upgrade')!.addEventListener('click', () => {
        const token = this.getAccessToken();
        if (!token) {
          alert('Please sign in to upgrade.');
          return;
        }
        startCheckout(token, 'monthly').catch(err => alert(err.message));
      });

      panel.querySelector('#settings-manage-sub')!.addEventListener('click', () => {
        const token = this.getAccessToken();
        if (!token) {
          alert('Please sign in to manage your subscription.');
          return;
        }
        openPortal(token).catch(err => alert(err.message));
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
        // Check entitlement for experience levels
        if (settingsKey === 'experienceLevel' && this.entitlements && !this.entitlements.canAccessLevel(level)) {
          if (this.upgradeHandler) this.upgradeHandler(`level:${level}`);
          return;
        }
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

  private bindAuthSection(): void {
    const auth = hotState.authManager;
    if (!auth) return; // No auth — section stays hidden

    const section = this.panel.querySelector<HTMLDivElement>('#settings-account-section');
    const content = this.panel.querySelector<HTMLDivElement>('#settings-account-content');
    const subSection = this.panel.querySelector<HTMLDivElement>('#settings-subscription-section');
    if (!section || !content) return;

    const render = (state: AuthState) => {
      content.innerHTML = '';
      if (state.loading) {
        section.style.display = 'none';
        if (subSection) subSection.style.display = 'none';
        return;
      }
      section.style.display = '';
      // Show subscription section only for authenticated (non-anonymous) users
      if (subSection) {
        subSection.style.display = (state.isAuthenticated && !state.isAnonymous) ? '' : 'none';
      }

      if (state.isAuthenticated && !state.isAnonymous && state.user) {
        const info = document.createElement('div');
        info.className = 'settings-account-info';
        if (state.user.name) {
          const nameEl = document.createElement('div');
          nameEl.className = 'settings-account-name';
          nameEl.textContent = state.user.name;
          info.appendChild(nameEl);
        }
        if (state.user.email) {
          const emailEl = document.createElement('div');
          emailEl.className = 'settings-account-email';
          emailEl.textContent = state.user.email;
          info.appendChild(emailEl);
        }
        content.appendChild(info);

        const signOutBtn = document.createElement('button');
        signOutBtn.className = 'settings-btn-reset settings-auth-btn';
        signOutBtn.textContent = 'sign out';
        signOutBtn.addEventListener('click', () => auth.signOut());
        content.appendChild(signOutBtn);
      } else if (state.isAnonymous) {
        const anon = document.createElement('div');
        anon.className = 'settings-account-anon';
        anon.textContent = 'browsing anonymously';
        content.appendChild(anon);

        const linkBtn = document.createElement('button');
        linkBtn.className = 'settings-btn-google settings-auth-btn';
        linkBtn.textContent = 'link google account';
        linkBtn.addEventListener('click', () => auth.linkGoogle());
        content.appendChild(linkBtn);
      } else {
        const signInBtn = document.createElement('button');
        signInBtn.className = 'settings-btn-google settings-auth-btn';
        signInBtn.textContent = 'sign in with google';
        signInBtn.addEventListener('click', () => auth.signInWithGoogle());
        content.appendChild(signInBtn);
      }
    };

    render(auth.getState());
    this.authUnsub = auth.onChange(render);
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
}
