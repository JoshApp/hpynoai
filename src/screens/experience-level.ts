/**
 * ExperienceLevelScreen — "how would you like to experience this?"
 *
 * Shows 4 levels: listen, watch, breathe, immerse.
 * Arrow keys or swipe to navigate, space/tap to confirm.
 * Selected level is saved and applied to settings.
 */

import * as THREE from 'three';
import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import { SpriteText } from '../sprite-text';
import { LEVEL_LABELS, type ExperienceLevel } from '../experience-level';
import { MENU_AUDIO_PRESET } from './audio-helpers';
import { log } from '../logger';

const LEVELS: ExperienceLevel[] = ['listen', 'watch', 'breathe', 'immerse'];
const LEVEL_SET_KEY = 'hpyno-level-set';

export class ExperienceLevelScreen implements Screen {
  readonly name = 'experience-level';

  private ctx: ScreenContext | null = null;
  private sprites: THREE.Sprite[] = [];
  private unsubs: Array<() => void> = [];
  private disposed = false;

  private nameSprites: THREE.Sprite[] = [];
  private descSprites: THREE.Sprite[] = [];
  private selectedIndex = 1; // default: 'watch'

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;
    this.disposed = false;
    ctx.hud.setMode('clean');

    // Presence moves to guide position
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'menu-guide' } });

    this.runSequence(ctx);
  }

  exit(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
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
      this.nameSprites = [];
      this.descSprites = [];
    }, 500);
    this.ctx = null;
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    this.ctx.breath.update(time);
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }

  // ── Sequence ──

  private async runSequence(ctx: ScreenContext): Promise<void> {
    await this.sleep(300);
    if (this.disposed) return;

    // Title
    const title = this.addSprite(ctx, 'how would you like to experience this?', {
      height: 0.065, fontSize: 36, color: '#c8a0ff', glow: 'rgba(200,160,255,0.3)',
    }, 0, 0.28, -0.1);
    await this.animateIn(title, 800);
    if (this.disposed) return;

    // Level options
    for (let i = 0; i < LEVELS.length; i++) {
      const lvl = LEVELS[i];
      const info = LEVEL_LABELS[lvl];
      const y = 0.12 - i * 0.09;

      const nameSprite = this.addSprite(ctx, `${info.icon}  ${info.name}`, {
        height: 0.055, fontSize: 36, color: '#c8a0ff', glow: 'rgba(200,160,255,0.3)',
      }, -0.15, y, -0.05);
      this.nameSprites.push(nameSprite);

      const descSprite = this.addSprite(ctx, info.desc, {
        height: 0.03, fontSize: 22, color: '#887aaa', glow: 'rgba(136,122,170,0.2)',
      }, 0.2, y, -0.05);
      this.descSprites.push(descSprite);

      await this.sleep(80);
      if (this.disposed) return;
      this.animateIn(nameSprite, 500);
      this.animateIn(descSprite, 500);
    }

    // Highlight default
    this.highlightLevel(this.selectedIndex);

    // Wait for selection
    const chosen = await this.waitForSelection(ctx);
    if (this.disposed) return;

    // Apply selection
    const level = LEVELS[chosen];
    ctx.settings.updateBatch({ experienceLevel: level });
    localStorage.setItem(LEVEL_SET_KEY, 'true');
    log.info('experience', `Level selected: ${level}`);

    // Pulse the chosen option briefly
    const chosenSprite = this.nameSprites[chosen];
    if (chosenSprite) {
      (chosenSprite.material as THREE.SpriteMaterial).opacity = 1;
    }
    await this.sleep(600);
    if (this.disposed) return;

    // Navigate to session selector
    const { SessionSelectorScreen } = await import('./session-selector');
    ctx.screenManager.replace(new SessionSelectorScreen(), {
      fadeOutMs: 800, holdMs: 200, fadeInMs: 800,
    });
  }

  private highlightLevel(selected: number): void {
    for (let i = 0; i < this.nameSprites.length; i++) {
      const active = i === selected;
      const included = i < selected;
      const nameMat = this.nameSprites[i]?.material as THREE.SpriteMaterial;
      const descMat = this.descSprites[i]?.material as THREE.SpriteMaterial;
      if (nameMat) nameMat.opacity = active ? 0.95 : included ? 0.6 : 0.3;
      if (descMat) descMat.opacity = active ? 0.7 : included ? 0.4 : 0.2;
    }
  }

  private waitForSelection(ctx: ScreenContext): Promise<number> {
    return new Promise(resolve => {
      const subs: Array<() => void> = [];
      const cleanup = () => { for (const u of subs) u(); };

      subs.push(ctx.bus.on('input:left', () => {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.highlightLevel(this.selectedIndex);
      }));
      subs.push(ctx.bus.on('input:right', () => {
        this.selectedIndex = Math.min(LEVELS.length - 1, this.selectedIndex + 1);
        this.highlightLevel(this.selectedIndex);
      }));
      subs.push(ctx.bus.on('input:confirm', () => {
        cleanup();
        resolve(this.selectedIndex);
      }));
      subs.push(ctx.bus.on('input:tap', () => {
        cleanup();
        resolve(this.selectedIndex);
      }));

      this.unsubs.push(...subs);
    });
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
        mat.opacity = t * t * (3 - 2 * t);
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
