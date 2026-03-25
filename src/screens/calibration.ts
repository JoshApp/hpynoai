/**
 * CalibrationScreen — immersive preview + optional adjustment.
 *
 * Shows a live preview of the experience with auto-calibrated settings.
 * The tunnel is running, text is floating, presence is breathing.
 * User sees "does this look right?" with two options:
 *   "looks good" → accept and continue
 *   "adjust" → reveals contextual sliders overlaid on the live preview
 *
 * Much more intuitive than abstract "tunnel speed: 1.0x" sliders.
 */

import * as THREE from 'three';
import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import { SpriteText } from '../sprite-text';
import { MENU_AUDIO_PRESET } from './audio-helpers';
import { log } from '../logger';

export class CalibrationScreen implements Screen {
  readonly name = 'calibration';

  private ctx: ScreenContext | null = null;
  private sprites: THREE.Sprite[] = [];
  private unsubs: Array<() => void> = [];
  private disposed = false;
  private adjustMode = false;
  private adjustSliders: HTMLDivElement | null = null;

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;
    this.disposed = false;
    ctx.hud.setMode('clean');

    // Set up a mini preview: tunnel running, presence breathing, sample text
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'narrator' } });

    // Show sample narration text so user can judge readability
    ctx.textActor.setDirective({
      type: 'text',
      directive: { mode: 'prompt', text: 'you are feeling calm\nand focused' },
    });

    this.runSequence(ctx);
  }

  exit(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const s of this.sprites) {
      if (this.ctx) {
        this.ctx.overlayScene.remove(s);
        (s.material as THREE.SpriteMaterial).map?.dispose();
        (s.material as THREE.SpriteMaterial).dispose();
      }
    }
    this.sprites = [];
    if (this.adjustSliders) {
      this.adjustSliders.remove();
      this.adjustSliders = null;
    }
    if (this.ctx) {
      this.ctx.textActor.setDirective({ type: 'text', directive: { mode: 'clear' } });
    }
    this.ctx = null;
  }

  render(time: number, dt: number): void {
    if (!this.ctx) return;
    this.ctx.breath.update(time);
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }

  private async runSequence(ctx: ScreenContext): Promise<void> {
    await this.sleep(800);
    if (this.disposed) return;

    // Question
    const question = this.addSprite(ctx, 'does this look right?', {
      height: 0.065, fontSize: 36, color: '#c8a0ff', glow: 'rgba(200,160,255,0.3)',
    }, 0, 0.30, -0.1);
    await this.animateIn(question, 800);
    if (this.disposed) return;

    // Hint about auto-calibration
    const hint = this.addSprite(ctx, 'we\'ve auto-adjusted for your device', {
      height: 0.03, fontSize: 22, color: '#8070a0', glow: 'rgba(128,112,160,0.15)',
    }, 0, 0.22, -0.08);
    await this.animateIn(hint, 600);
    if (this.disposed) return;

    await this.sleep(500);
    if (this.disposed) return;

    // Two options
    const looksGood = this.addSprite(ctx, '✓  looks good', {
      height: 0.05, fontSize: 32, color: '#a0e0b0', glow: 'rgba(160,224,176,0.3)',
    }, -0.15, -0.22, -0.05);

    const adjust = this.addSprite(ctx, '⚙  adjust', {
      height: 0.05, fontSize: 32, color: '#b0a0c0', glow: 'rgba(176,160,192,0.2)',
    }, 0.15, -0.22, -0.05);

    await this.animateIn(looksGood, 500);
    await this.animateIn(adjust, 500);
    if (this.disposed) return;

    // Wait for choice — left/confirm = looks good, right = adjust
    const choice = await this.waitForChoice(ctx, looksGood, adjust);
    if (this.disposed) return;

    if (choice === 'adjust') {
      // Enter adjustment mode
      this.animateOut(question, 400);
      this.animateOut(hint, 400);
      this.animateOut(looksGood, 400);
      this.animateOut(adjust, 400);
      await this.sleep(500);
      if (this.disposed) return;

      await this.showAdjustMode(ctx);
      if (this.disposed) return;
    }

    // Done — navigate to selector
    this.animateOut(question, 400);
    this.animateOut(hint, 400);
    this.animateOut(looksGood, 400);
    this.animateOut(adjust, 400);

    await this.sleep(500);

    // First-time flow: calibration → experience level → selector
    const hasChosenLevel = localStorage.getItem('hpyno-level-set') === 'true';
    if (!hasChosenLevel) {
      const { ExperienceLevelScreen } = await import('./experience-level');
      ctx.screenManager.replace(new ExperienceLevelScreen(), {
        fadeOutMs: 800, holdMs: 200, fadeInMs: 800,
      });
    } else {
      const { SessionSelectorScreen } = await import('./session-selector');
      ctx.screenManager.replace(new SessionSelectorScreen(), {
        fadeOutMs: 800, holdMs: 200, fadeInMs: 800,
      });
    }
  }

  private async showAdjustMode(ctx: ScreenContext): Promise<void> {
    this.adjustMode = true;

    // Show contextual sliders as a DOM overlay (glassmorphism, bottom of screen)
    const container = document.createElement('div');
    container.style.cssText = `
      position: fixed; bottom: 16px; left: 12px; right: 12px;
      max-width: 400px; margin: 0 auto;
      background: rgba(0,0,0,0.5); backdrop-filter: blur(14px);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 14px; padding: 16px;
      font: 12px -apple-system, sans-serif; color: rgba(255,255,255,0.6);
      z-index: 1001; pointer-events: auto;
      display: flex; flex-direction: column; gap: 12px;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
    `;

    const s = ctx.settings.current;

    container.innerHTML = `
      <div style="font-size: 11px; opacity: 0.4; text-transform: uppercase; letter-spacing: 0.1em;">adjust to your preference</div>
      ${this.sliderRow('tunnel speed', 'tunnelSpeed', s.tunnelSpeed, 0, 3, 0.1)}
      ${this.sliderRow('text size', 'narrationScale', s.narrationScale, 0.5, 3, 0.1)}
      ${this.sliderRow('volume', 'masterVolume', s.masterVolume, 0, 2, 0.05)}
      ${this.sliderRow('camera distance', 'cameraZ', s.cameraZ, 0.5, 5, 0.1)}
      <button id="cal-done" style="
        background: rgba(160,224,176,0.15); border: 1px solid rgba(160,224,176,0.2);
        color: #a0e0b0; border-radius: 8px; padding: 10px; cursor: pointer;
        font: 13px -apple-system, sans-serif; margin-top: 4px;
      ">done</button>
    `;

    // Prevent events from reaching canvas
    container.addEventListener('mousedown', e => e.stopPropagation());
    container.addEventListener('click', e => e.stopPropagation());
    container.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

    document.body.appendChild(container);
    this.adjustSliders = container;

    // Wire sliders
    container.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(slider => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.key as keyof typeof s;
        const val = parseFloat(slider.value);
        ctx.settings.updateBatch({ [key]: val } as Record<string, number>);
        // Update live value display
        const valEl = container.querySelector(`#cal-val-${key}`);
        if (valEl) valEl.textContent = val.toFixed(1);
      });
    });

    // Wait for done
    await new Promise<void>(resolve => {
      (container.querySelector('#cal-done') as HTMLButtonElement).addEventListener('click', () => resolve());
    });

    // Clean up
    container.remove();
    this.adjustSliders = null;
    this.adjustMode = false;
  }

  private sliderRow(label: string, key: string, value: number, min: number, max: number, step: number): string {
    return `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="flex: 0 0 100px; font-size: 11px; opacity: 0.5;">${label}</span>
        <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="
          flex: 1; -webkit-appearance: none; appearance: none;
          height: 3px; border-radius: 2px; background: rgba(255,255,255,0.12);
          outline: none; cursor: pointer;
        ">
        <span id="cal-val-${key}" style="flex: 0 0 30px; text-align: right; font-size: 10px; opacity: 0.4; font-variant-numeric: tabular-nums;">${value.toFixed(1)}</span>
      </div>
    `;
  }

  // ── Helpers ──

  private waitForChoice(
    ctx: ScreenContext,
    leftSprite: THREE.Sprite,
    rightSprite: THREE.Sprite,
  ): Promise<'accept' | 'adjust'> {
    return new Promise(resolve => {
      let selected: 'accept' | 'adjust' = 'accept';
      const highlight = () => {
        (leftSprite.material as THREE.SpriteMaterial).opacity = selected === 'accept' ? 0.95 : 0.3;
        (rightSprite.material as THREE.SpriteMaterial).opacity = selected === 'adjust' ? 0.95 : 0.3;
      };
      highlight();

      const subs: Array<() => void> = [];
      const done = () => { for (const u of subs) u(); resolve(selected); };

      subs.push(ctx.bus.on('input:left', () => { selected = 'accept'; highlight(); }));
      subs.push(ctx.bus.on('input:right', () => { selected = 'adjust'; highlight(); }));
      subs.push(ctx.bus.on('input:confirm', done));
      subs.push(ctx.bus.on('input:tap', done));
      this.unsubs.push(...subs);
    });
  }

  private addSprite(
    ctx: ScreenContext, text: string,
    opts: { height: number; fontSize: number; color: string; glow: string },
    x: number, y: number, z: number,
  ): THREE.Sprite {
    const sprite = SpriteText.create(text, { fontSize: opts.fontSize, color: opts.color, glow: opts.glow });
    const scale = opts.height;
    sprite.scale.set(scale * (sprite.userData.aspect ?? 4), scale, 1);
    sprite.position.set(x, y, z);
    (sprite.material as THREE.SpriteMaterial).opacity = 0;
    (sprite.material as THREE.SpriteMaterial).depthTest = false;
    ctx.overlayScene.add(sprite);
    this.sprites.push(sprite);
    return sprite;
  }

  private animateIn(sprite: THREE.Sprite, ms: number): Promise<void> {
    return new Promise(resolve => {
      const mat = sprite.material as THREE.SpriteMaterial;
      const start = performance.now();
      const tick = () => {
        const t = Math.min(1, (performance.now() - start) / ms);
        mat.opacity = t * t * (3 - 2 * t);
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private animateOut(sprite: THREE.Sprite, ms: number): void {
    const mat = sprite.material as THREE.SpriteMaterial;
    const startOp = mat.opacity;
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      mat.opacity = startOp * (1 - t);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
