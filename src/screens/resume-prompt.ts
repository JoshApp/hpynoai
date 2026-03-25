/**
 * ResumePromptScreen — immersive 3D prompt to resume a saved session.
 *
 * Shows session info + two options: "continue" / "start fresh".
 * Left/right to select, space/tap to confirm. No async, no sleeps.
 */

import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import type { SavedSession } from '../session-persistence';
import { clearProgress, formatTime } from '../session-persistence';
import { SpriteText } from '../sprite-text';
import { sessions } from '../sessions/index';
import { MENU_AUDIO_PRESET } from './audio-helpers';
import { log } from '../logger';
import * as THREE from 'three';

export class ResumePromptScreen implements Screen {
  readonly name = 'resume-prompt';

  private ctx: ScreenContext | null = null;
  private saved: SavedSession;
  private unsubs: Array<() => void> = [];
  private sprites: THREE.Sprite[] = [];
  private timeoutTimer: number | null = null;
  private selectedIndex = 0; // 0 = continue, 1 = start fresh
  private navigating = false;
  private startTime = 0;

  // Option sprites for highlighting
  private continueSprite: THREE.Sprite | null = null;
  private freshSprite: THREE.Sprite | null = null;

  constructor(saved: SavedSession) {
    this.saved = saved;
  }

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;
    this.startTime = performance.now() / 1000;
    this.navigating = false;
    this.selectedIndex = 0;
    ctx.hud.setMode('clean');

    const session = sessions.find(s => s.id === this.saved.sessionId);
    const sessionName = session?.name ?? this.saved.sessionId;
    const icon = session?.icon ?? '';
    const timeStr = formatTime(this.saved.position);

    // Presence
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'idle' } });

    // Title — session info
    this.addSprite(ctx, `${icon} ${sessionName}`, {
      fontSize: 64, color: '#d4b8ff', glow: 'rgba(200,160,255,0.5)', height: 0.12,
    }, 0, 0.2, -0.1);

    this.addSprite(ctx, `paused at ${timeStr}`, {
      fontSize: 36, color: '#a090c0', glow: 'rgba(160,144,192,0.3)', height: 0.05,
    }, 0, 0.05, -0.05);

    // Options
    this.continueSprite = this.addSprite(ctx, '▶  continue', {
      fontSize: 42, color: '#c8b8ff', glow: 'rgba(200,184,255,0.5)', height: 0.065,
    }, 0, -0.12, -0.04);

    this.freshSprite = this.addSprite(ctx, '✦  start fresh', {
      fontSize: 42, color: '#a090c0', glow: 'rgba(160,144,192,0.3)', height: 0.065,
    }, 0, -0.22, -0.04);

    // Input
    this.unsubs.push(ctx.bus.on('input:left', () => { this.selectedIndex = 0; }));
    this.unsubs.push(ctx.bus.on('input:right', () => { this.selectedIndex = 1; }));
    this.unsubs.push(ctx.bus.on('input:confirm', () => this.confirm()));
    this.unsubs.push(ctx.bus.on('input:tap', () => this.confirm()));
    this.unsubs.push(ctx.bus.on('input:back', () => { this.selectedIndex = 1; this.confirm(); }));

    // Also navigate with up/down
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'ArrowUp' || e.code === 'KeyW') { this.selectedIndex = 0; e.preventDefault(); }
      if (e.code === 'ArrowDown' || e.code === 'KeyS') { this.selectedIndex = 1; e.preventDefault(); }
    };
    document.addEventListener('keydown', onKey);
    this.unsubs.push(() => document.removeEventListener('keydown', onKey));

    // Auto-dismiss after 15 seconds → go to selector
    this.timeoutTimer = window.setTimeout(() => {
      if (!this.navigating) { this.selectedIndex = 1; this.confirm(); }
    }, 15000);

    log.info('resume', `Showing resume prompt: ${sessionName} at ${timeStr}`);
  }

  exit(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.ctx) {
      for (const s of this.sprites) {
        this.ctx.overlayScene.remove(s);
        (s.material as THREE.SpriteMaterial).map?.dispose();
        (s.material as THREE.SpriteMaterial).dispose();
      }
      this.ctx.textActor.setDirective({ type: 'text', directive: { mode: 'clear' } });
    }
    this.sprites = [];
    this.continueSprite = null;
    this.freshSprite = null;
    this.ctx = null;
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    this.ctx.breath.update(time);
    const elapsed = time - this.startTime;

    // Fade in all sprites
    for (let i = 0; i < this.sprites.length; i++) {
      const mat = this.sprites[i].material as THREE.SpriteMaterial;
      const fadeStart = i * 0.3;
      const t = Math.max(0, Math.min(1, (elapsed - fadeStart) / 1.0));
      const baseOpacity = t * t * (3 - 2 * t) * 0.9;

      // Highlight selected option
      if (this.sprites[i] === this.continueSprite) {
        const selected = this.selectedIndex === 0;
        const pulse = selected ? 0.85 + Math.sin(time * 3) * 0.15 : 0.35;
        mat.opacity = baseOpacity * pulse;
        // Scale selected larger
        const scale = selected ? 0.075 : 0.06;
        const aspect = this.sprites[i].userData.aspect ?? 4;
        this.sprites[i].scale.set(scale * aspect, scale, 1);
      } else if (this.sprites[i] === this.freshSprite) {
        const selected = this.selectedIndex === 1;
        const pulse = selected ? 0.85 + Math.sin(time * 3) * 0.15 : 0.35;
        mat.opacity = baseOpacity * pulse;
        const scale = selected ? 0.075 : 0.06;
        const aspect = this.sprites[i].userData.aspect ?? 4;
        this.sprites[i].scale.set(scale * aspect, scale, 1);
      } else {
        mat.opacity = baseOpacity;
      }
    }
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }

  // ── Private ──

  private async confirm(): Promise<void> {
    if (!this.ctx || this.navigating) return;
    this.navigating = true;

    const session = sessions.find(s => s.id === this.saved.sessionId);

    if (this.selectedIndex === 0 && session) {
      // Resume
      log.info('resume', `Resuming ${session.name}`);
      const { SessionScreen } = await import('./session');
      this.ctx.screenManager.replace(
        new SessionScreen(session, { resumePosition: this.saved.position }),
        { fadeOutMs: 1000, holdMs: 300, fadeInMs: 800 },
      );
    } else {
      // Start fresh
      clearProgress();
      log.info('resume', 'Starting fresh');
      const { SessionSelectorScreen } = await import('./session-selector');
      this.ctx.screenManager.replace(
        new SessionSelectorScreen(),
        { fadeOutMs: 800, holdMs: 200, fadeInMs: 600 },
      );
    }
  }

  private addSprite(
    ctx: ScreenContext, text: string,
    opts: { fontSize: number; color: string; glow: string; height: number },
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
}
