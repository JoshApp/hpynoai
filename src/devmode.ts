/**
 * Dev/debug mode — overlay panel for working on the experience
 * without getting hypnotized every time you test it.
 *
 * Toggle: backtick key (`)
 * Auto-enable: ?dev URL parameter
 */

import { Timeline } from './timeline';
import { AudioEngine } from './audio';
import { InteractionManager } from './interactions';

export interface DevModeOptions {
  timeline: Timeline;
  audio: AudioEngine;
  interactions: InteractionManager;
  getIntensity: () => number;
  setIntensityOverride: (v: number | null) => void;
  getShaderIntensityScale: () => number;
  setShaderIntensityScale: (v: number) => void;
  onRestart: () => void;
}

export class DevMode {
  private panel: HTMLDivElement;
  private visible = false;
  private safeModeOn = false;
  private muted = false;
  private speedMultiplier = 1;
  private opts: DevModeOptions;
  private startTime = performance.now();
  private lastFrameTime = performance.now();
  private frameCount = 0;
  private fps = 0;

  // stat elements
  private elStage!: HTMLSpanElement;
  private elIntensity!: HTMLSpanElement;
  private elBreath!: HTMLSpanElement;
  private elElapsed!: HTMLSpanElement;
  private elFps!: HTMLSpanElement;
  private elSpeed!: HTMLSpanElement;
  private elSafe!: HTMLSpanElement;

  constructor(opts: DevModeOptions) {
    this.opts = opts;

    this.panel = document.createElement('div');
    this.panel.id = 'dev-panel';
    this.panel.innerHTML = this.buildHTML();
    document.body.appendChild(this.panel);

    this.elStage = this.panel.querySelector('#dev-stage')!;
    this.elIntensity = this.panel.querySelector('#dev-intensity')!;
    this.elBreath = this.panel.querySelector('#dev-breath')!;
    this.elElapsed = this.panel.querySelector('#dev-elapsed')!;
    this.elFps = this.panel.querySelector('#dev-fps')!;
    this.elSpeed = this.panel.querySelector('#dev-speed')!;
    this.elSafe = this.panel.querySelector('#dev-safe')!;

    this.bindEvents();

    if (new URLSearchParams(window.location.search).has('dev')) {
      this.show();
      this.setSafeMode(true);
    }
  }

  /** Rebuild stage buttons when session changes */
  rebuildStageButtons(): void {
    const container = this.panel.querySelector('.dev-stage-btns');
    if (!container) return;
    const tl = this.opts.timeline;
    container.innerHTML = tl.allBlocks
      .map((b, i) => `<button class="dev-stage-btn" data-index="${i}">${b.stage.name} (${b.kind[0]})</button>`)
      .join('');
    container.querySelectorAll<HTMLButtonElement>('.dev-stage-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index!, 10);
        const block = tl.allBlocks[idx];
        if (block) tl.seek(block.start);
      });
    });
  }

  private buildHTML(): string {
    const tl = this.opts.timeline;
    const stageButtons = tl.allBlocks
      .map((b, i) => `<button class="dev-stage-btn" data-index="${i}">${b.stage.name} (${b.kind[0]})</button>`)
      .join('');

    return `
      <div class="dev-header">DEV MODE</div>
      <div class="dev-stats">
        <div>stage: <span id="dev-stage">--</span></div>
        <div>intensity: <span id="dev-intensity">0.00</span></div>
        <div>breath: <span id="dev-breath">--</span></div>
        <div>elapsed: <span id="dev-elapsed">0:00</span></div>
        <div>fps: <span id="dev-fps">0</span></div>
        <div>speed: <span id="dev-speed">1x</span></div>
        <div>safe mode: <span id="dev-safe">OFF</span></div>
      </div>
      <div class="dev-section">
        <div class="dev-label">stages</div>
        <div class="dev-stage-btns">${stageButtons}</div>
      </div>
      <div class="dev-section">
        <div class="dev-label">speed</div>
        <div class="dev-speed-btns">
          <button class="dev-speed-btn" data-speed="1">1x</button>
          <button class="dev-speed-btn" data-speed="2">2x</button>
          <button class="dev-speed-btn" data-speed="4">4x</button>
          <button class="dev-speed-btn" data-speed="8">8x</button>
        </div>
      </div>
      <div class="dev-section">
        <div class="dev-label">intensity override</div>
        <input type="range" id="dev-intensity-slider" min="0" max="100" value="50" />
        <div class="dev-row">
          <button id="dev-intensity-apply">apply</button>
          <button id="dev-intensity-clear">clear</button>
        </div>
      </div>
      <div class="dev-section dev-row">
        <button id="dev-mute">mute audio</button>
        <button id="dev-safe-toggle">safe mode</button>
        <button id="dev-skip-interaction">skip interaction</button>
      </div>
      <div class="dev-section">
        <button id="dev-restart" class="dev-btn-wide">restart</button>
      </div>
    `;
  }

  private bindEvents(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key === '`') {
        e.preventDefault();
        this.visible ? this.hide() : this.show();
      }
    });

    // Stage skip buttons
    this.panel.querySelectorAll<HTMLButtonElement>('.dev-stage-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index!, 10);
        const block = this.opts.timeline.allBlocks[idx];
        if (block) this.opts.timeline.seek(block.start);
      });
    });

    // Speed buttons
    this.panel.querySelectorAll<HTMLButtonElement>('.dev-speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.speedMultiplier = parseInt(btn.dataset.speed!, 10);
        this.opts.timeline.setSpeed(this.speedMultiplier);
        this.elSpeed.textContent = `${this.speedMultiplier}x`;
        this.panel.querySelectorAll('.dev-speed-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Intensity override
    const slider = this.panel.querySelector<HTMLInputElement>('#dev-intensity-slider')!;
    this.panel.querySelector('#dev-intensity-apply')!.addEventListener('click', () => {
      this.opts.setIntensityOverride(slider.valueAsNumber / 100);
    });
    this.panel.querySelector('#dev-intensity-clear')!.addEventListener('click', () => {
      this.opts.setIntensityOverride(null);
    });

    // Mute
    this.panel.querySelector('#dev-mute')!.addEventListener('click', () => {
      this.muted = !this.muted;
      this.opts.audio.setMuted(this.muted);
      (this.panel.querySelector('#dev-mute') as HTMLButtonElement).textContent =
        this.muted ? 'unmute audio' : 'mute audio';
    });

    // Safe mode
    this.panel.querySelector('#dev-safe-toggle')!.addEventListener('click', () => {
      this.setSafeMode(!this.safeModeOn);
    });

    // Skip interaction
    this.panel.querySelector('#dev-skip-interaction')!.addEventListener('click', () => {
      this.opts.interactions.skip();
    });

    // Restart
    this.panel.querySelector('#dev-restart')!.addEventListener('click', () => {
      this.opts.onRestart();
      this.startTime = performance.now();
    });
  }

  private setSafeMode(on: boolean): void {
    this.safeModeOn = on;
    this.elSafe.textContent = on ? 'ON' : 'OFF';
    this.elSafe.style.color = on ? '#6f6' : '#f66';
    (this.panel.querySelector('#dev-safe-toggle') as HTMLButtonElement).textContent =
      on ? 'safe mode: ON' : 'safe mode: OFF';
    this.opts.setShaderIntensityScale(on ? 0.3 : 1.0);
    this.opts.audio.setBinauralEnabled(!on);
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

  update(): void {
    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFrameTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFrameTime = now;
    }

    if (!this.visible) return;

    const tl = this.opts.timeline;
    const block = tl.currentBlock;
    const stage = block?.stage;
    const intensity = this.opts.getIntensity();
    const elapsed = tl.position;
    const breathCycle = stage?.breathCycle ?? 7;
    const breathPhase = (performance.now() / 1000) * (2 * Math.PI / breathCycle);
    const breathLabel = Math.sin(breathPhase) > 0 ? 'inhale' : 'exhale';

    this.elStage.textContent = `${stage?.name ?? '—'} [${block?.kind ?? '?'}] ${tl.currentIndex + 1}/${tl.blockCount}`;
    this.elIntensity.textContent = intensity.toFixed(3);
    this.elBreath.textContent = `${breathLabel} (${breathCycle.toFixed(1)}s)`;
    this.elElapsed.textContent = this.formatTime(elapsed);
    this.elFps.textContent = String(this.fps);
  }

  private formatTime(s: number): string {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  destroy(): void {
    this.panel.remove();
  }
}
