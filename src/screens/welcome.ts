/**
 * WelcomeScreen — title + "tap to begin".
 *
 * No async sequences, no sleeps, no skip flags.
 * Just a state machine driven by the render loop.
 * Any input at any time advances to the next screen.
 */

import * as THREE from 'three';
import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import { SpriteText } from '../sprite-text';
import { MENU_AUDIO_PRESET, ensureAudioCompositor, playOpeningTone } from './audio-helpers';
import { log } from '../logger';

export class WelcomeScreen implements Screen {
  readonly name = 'welcome';

  private ctx: ScreenContext | null = null;
  private unsubs: Array<() => void> = [];
  private sprites: THREE.Sprite[] = [];
  private startTime = 0;
  private audioStarted = false;
  private navigating = false;

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;
    this.startTime = performance.now() / 1000;
    this.navigating = false;
    ctx.hud.setMode('clean');

    // Presence
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'idle' } });

    // Create all sprites upfront (invisible)
    this.addSprite(ctx, 'H P Y N O', {
      fontSize: 96, color: '#d4b8ff', glow: 'rgba(200,160,255,0.5)', height: 0.18,
    }, 0, 0.15, -0.15);

    this.addSprite(ctx, 'immersive hypnosis', {
      fontSize: 38, color: '#b89ee0', glow: 'rgba(184,158,224,0.4)', height: 0.06,
    }, 0, -0.05, -0.06);

    const isTouchDevice = 'ontouchstart' in window;
    this.addSprite(ctx, isTouchDevice ? 'tap to enter' : 'press space', {
      fontSize: 38, color: '#e0c8ff', glow: 'rgba(224,200,255,0.5)', height: 0.06,
    }, 0, -0.25, -0.02);

    // ANY input → go to next screen
    const advance = () => this.advance();
    this.unsubs.push(ctx.bus.on('input:confirm', advance));
    this.unsubs.push(ctx.bus.on('input:tap', advance));

    // Start audio in background (don't block anything)
    this.initAudio(ctx);

    log.info('welcome', 'Entered');
  }

  exit(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.ctx) {
      for (const s of this.sprites) {
        this.ctx.overlayScene.remove(s);
        (s.material as THREE.SpriteMaterial).map?.dispose();
        (s.material as THREE.SpriteMaterial).dispose();
      }
    }
    this.sprites = [];
    this.ctx = null;
    log.info('welcome', 'Exited');
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    this.ctx.breath.update(time);

    const elapsed = time - this.startTime;

    // Fade in sprites based on elapsed time
    // [0] title: fade in 0-1.5s
    // [1] tagline: fade in 1-2.5s
    // [2] prompt: fade in 2-3.5s, then pulse
    for (let i = 0; i < this.sprites.length; i++) {
      const mat = this.sprites[i].material as THREE.SpriteMaterial;
      const fadeStart = i * 1.0; // stagger by 1s each
      const fadeDur = 1.5;
      const t = Math.max(0, Math.min(1, (elapsed - fadeStart) / fadeDur));
      const eased = t * t * (3 - 2 * t); // smoothstep

      if (i === this.sprites.length - 1 && t >= 1) {
        // Prompt: pulse after fully visible
        mat.opacity = 0.5 + Math.sin(time * 2) * 0.3;
      } else {
        mat.opacity = eased * 0.9;
      }
    }
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }

  // ── Private ──

  private async advance(): Promise<void> {
    if (!this.ctx || this.navigating) return;
    this.navigating = true;
    const { SessionSelectorScreen } = await import('./session-selector');
    this.ctx.screenManager.replace(new SessionSelectorScreen(), {
      fadeOutMs: 800, holdMs: 200, fadeInMs: 800,
    });
  }

  private async initAudio(ctx: ScreenContext): Promise<void> {
    if (this.audioStarted) return;
    this.audioStarted = true;
    try {
      await ensureAudioCompositor(ctx.audio, ctx.audioCompositor);
      ctx.audioCompositor.setMasterVolume(ctx.settings.current.ambientVolume);
      if (!ctx.audioCompositor['isPlaying']) {
        ctx.audioCompositor.start(MENU_AUDIO_PRESET);
      }
      playOpeningTone(ctx.audio);
    } catch { /* ok */ }
  }

  private addSprite(
    ctx: ScreenContext, text: string,
    opts: { fontSize: number; color: string; glow: string; height: number },
    x: number, y: number, z: number,
  ): void {
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
  }
}
