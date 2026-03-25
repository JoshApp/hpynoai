/**
 * WelcomeScreen — first-time onboarding + title cinematic.
 *
 * Sequence:
 *   1. HPYNO title fades in with presence wisp
 *   2. "immersive hypnosis" tagline
 *   3. First visit: onboarding tips ("headphones recommended", "find a quiet space")
 *   4. "tap to begin" / "press space"
 *   5. → ExperienceLevelScreen (first visit) or SessionSelectorScreen (returning)
 */

import * as THREE from 'three';
import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import { SpriteText } from '../sprite-text';
import { MENU_AUDIO_PRESET, playOpeningTone, ensureAudioCompositor } from './audio-helpers';
import { log } from '../logger';

const FIRST_VISIT_KEY = 'hpyno-welcomed';

export class WelcomeScreen implements Screen {
  readonly name = 'welcome';

  private ctx: ScreenContext | null = null;
  private sprites: THREE.Sprite[] = [];
  private unsubs: Array<() => void> = [];
  private disposed = false;
  private promptSprite: THREE.Sprite | null = null;

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;
    this.disposed = false;
    ctx.hud.setMode('clean'); // no UI during title cinematic

    // Presence: gentle idle
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'idle' } });

    this.runSequence(ctx);
  }

  exit(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // Fade out all sprites
    for (const s of this.sprites) {
      this.animateOut(s, 400);
    }
    setTimeout(() => {
      for (const s of this.sprites) {
        if (this.ctx) {
          this.ctx.overlayScene.remove(s);
          (s.material as THREE.SpriteMaterial).map?.dispose();
          (s.material as THREE.SpriteMaterial).dispose();
        }
      }
      this.sprites = [];
    }, 500);
    this.ctx = null;
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    this.ctx.breath.update(time);

    // Pulse the prompt sprite
    if (this.promptSprite) {
      const pulse = 0.5 + Math.sin(time * 2) * 0.2;
      (this.promptSprite.material as THREE.SpriteMaterial).opacity = pulse;
    }
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }

  // ── Sequence ──

  private async runSequence(ctx: ScreenContext): Promise<void> {
    // Start menu audio + opening tone
    await ensureAudioCompositor(ctx.audio, ctx.audioCompositor);
    playOpeningTone(ctx.audio);

    await this.sleep(500);
    if (this.disposed) return;

    // Title
    const title = this.addSprite(ctx, 'H P Y N O', {
      height: 0.18, fontSize: 96, color: '#d4b8ff', glow: 'rgba(200,160,255,0.5)',
    }, 0, 0.30, -0.15);
    await this.animateIn(title, 1400);
    if (this.disposed) return;

    // Tagline
    const tagline = this.addSprite(ctx, 'immersive hypnosis', {
      height: 0.06, fontSize: 38, color: '#b89ee0', glow: 'rgba(184,158,224,0.4)',
    }, 0, -0.15, -0.06);
    await this.animateIn(tagline, 1000);
    if (this.disposed) return;

    // First visit: onboarding tips
    const isFirstVisit = localStorage.getItem(FIRST_VISIT_KEY) !== 'true';
    if (isFirstVisit) {
      await this.sleep(1200);
      if (this.disposed) return;

      // Tip 1: headphones
      const tip1 = this.addSprite(ctx, '🎧  headphones recommended', {
        height: 0.04, fontSize: 28, color: '#a090c0', glow: 'rgba(160,144,192,0.25)',
      }, 0, -0.28, -0.04);
      await this.animateIn(tip1, 800);
      if (this.disposed) return;

      await this.sleep(1500);
      if (this.disposed) return;

      // Tip 2: environment
      const tip2 = this.addSprite(ctx, '🌙  find a quiet, comfortable space', {
        height: 0.04, fontSize: 28, color: '#a090c0', glow: 'rgba(160,144,192,0.25)',
      }, 0, -0.34, -0.04);
      await this.animateIn(tip2, 800);
      if (this.disposed) return;

      await this.sleep(1500);
      if (this.disposed) return;

      // Fade tips
      this.animateOut(tip1, 600);
      this.animateOut(tip2, 600);
      await this.sleep(800);
      if (this.disposed) return;
    }

    // CTA
    await this.sleep(400);
    if (this.disposed) return;

    const isTouchDevice = 'ontouchstart' in window;
    const prompt = this.addSprite(ctx,
      isTouchDevice ? 'tap to enter' : 'press space',
      { height: 0.06, fontSize: 38, color: '#e0c8ff', glow: 'rgba(224,200,255,0.5)' },
      0, -0.26, -0.02,
    );
    this.promptSprite = prompt;
    await this.animateIn(prompt, 800);
    if (this.disposed) return;

    // Wait for user input
    await this.waitForInput(ctx);
    if (this.disposed) return;
    this.promptSprite = null;

    // Mark welcomed
    localStorage.setItem(FIRST_VISIT_KEY, 'true');

    // Navigate
    if (isFirstVisit) {
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

  // ── Helpers ──

  private addSprite(
    ctx: ScreenContext, text: string,
    opts: { height: number; fontSize: number; color: string; glow: string },
    x: number, y: number, z: number,
  ): THREE.Sprite {
    const sprite = SpriteText.create(text, {
      fontSize: opts.fontSize,
      color: opts.color,
      glow: opts.glow,
    });
    const scale = opts.height;
    sprite.scale.set(scale * (sprite.userData.aspect ?? 4), scale, 1);
    sprite.position.set(x, y, z);
    (sprite.material as THREE.SpriteMaterial).opacity = 0;
    (sprite.material as THREE.SpriteMaterial).depthTest = false;
    ctx.overlayScene.add(sprite);
    this.sprites.push(sprite);
    return sprite;
  }

  private animateIn(sprite: THREE.Sprite, durationMs: number): Promise<void> {
    return new Promise(resolve => {
      const mat = sprite.material as THREE.SpriteMaterial;
      const start = performance.now();
      const tick = () => {
        const t = Math.min(1, (performance.now() - start) / durationMs);
        mat.opacity = t * t * (3 - 2 * t); // smoothstep
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private animateOut(sprite: THREE.Sprite, durationMs: number): void {
    const mat = sprite.material as THREE.SpriteMaterial;
    const startOpacity = mat.opacity;
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / durationMs);
      mat.opacity = startOpacity * (1 - t);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private waitForInput(ctx: ScreenContext): Promise<void> {
    return new Promise(resolve => {
      const done = () => { for (const u of subs) u(); resolve(); };
      const subs: Array<() => void> = [];
      subs.push(ctx.bus.on('input:confirm', done));
      subs.push(ctx.bus.on('input:tap', done));
      this.unsubs.push(...subs);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
