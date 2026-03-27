/**
 * SessionSelectorScreen — carousel of available sessions.
 *
 * Wraps the existing SessionSelector class for now.
 * TODO: absorb selector.ts fully into this screen.
 */

import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import type { SessionConfig } from '../session';
import { SessionSelector, type SelectorSession } from '../selector';
import { sessionStore, type SessionSummary } from '../session-store';
import {
  resumeAudioFromGesture, ensureAudioCompositor,
  MENU_AUDIO_PRESET, MENU_WHISPER_PRESET, playOpeningTone,
} from './audio-helpers';
import { log } from '../logger';

export class SessionSelectorScreen implements Screen {
  readonly name = 'session-selector';

  private ctx: ScreenContext | null = null;
  private selector: SessionSelector | null = null;
  private unsubs: Array<() => void> = [];
  private menuAudioStarted = false;
  private previewFadeTimer: number | null = null;
  private skipIntro: boolean;

  // Theme color lerp targets
  private targetColors = {
    c1: [0.45, 0.1, 0.55] as [number, number, number],
    c2: [0.7, 0.3, 0.9] as [number, number, number],
    c3: [0.6, 0.3, 0.8] as [number, number, number],
    c4: [0.15, 0.02, 0.25] as [number, number, number],
    particle: [0.5, 0.35, 0.9] as [number, number, number],
    shape: 0,
  };

  // Render state
  private lastAnimTime = 0;
  private spiralAngle = 0;

  constructor(opts?: { skipIntro?: boolean }) {
    this.skipIntro = opts?.skipIntro ?? false;
  }

  enter(ctx: ScreenContext, from: string | null): void {
    this.ctx = ctx;
    ctx.machine.transition('selector');
    ctx.hud.setMode('menu');

    // Start menu audio in background — don't block screen setup
    this.startMenuAudio(ctx).catch(() => {});

    // Build selector sessions from store (runtime) with fallback to hardcoded
    const selectorSessions = this.buildSelectorSessions();

    // Create selector carousel
    this.selector = new SessionSelector(
      selectorSessions,
      (session) => this.onSessionSelect(session),
      ctx.overlayScene,
      ctx.camera,
      ctx.canvas,
      ctx.bus,
      // Always skip intro — WelcomeScreen handles title, ExperienceLevelScreen handles level picker
      true,
    );

    this.selector.setExperienceLevelControl((level) => {
      ctx.settings.updateBatch({ experienceLevel: level });
    });

    ctx.bus.emit('selector:ready', {});

    this.selector.setPresenceControl((x, y, z) => {
      ctx.presenceActor.follow(x, y, z);
    }, () => {
      ctx.presenceActor.pulse();
    });

    this.selector.setThemeControl((colors) => {
      this.targetColors.c1 = colors.c1;
      this.targetColors.c2 = colors.c2;
      this.targetColors.c3 = colors.c3;
      this.targetColors.c4 = colors.c4;
      this.targetColors.particle = colors.particle;
      this.targetColors.shape = colors.shape;
      ctx.presenceActor.setColors(colors.c3 as [number, number, number]);
    });

    // Audio preview on session hover — uses minimal data, no full config needed
    this.selector.setAudioPreview((session) => {
      if (!this.menuAudioStarted) return;
      if (this.previewFadeTimer) { clearTimeout(this.previewFadeTimer); this.previewFadeTimer = null; }

      const rootNotes: Record<string, number> = { relax: 48, sleep: 45, focus: 52, surrender: 50 };
      const root = rootNotes[session.id] ?? 48;

      ctx.audioCompositor.applyPreset({
        binaural: { carrierFreq: 120, beatFreq: 10, volume: 0.15 },
        drone: { rootNote: root - 12, harmonicity: 2, modIndex: 2, volume: 0.1 },
        pad: { chord: [root, root + 4, root + 7, root + 12], filterMax: 800, warmth: 0.7, chorusRate: 0.2, volume: 0.12 },
        noise: { type: 'pink', filterFreq: 300, volume: 0.05 },
      } as Partial<AudioPreset>, 1.5);

      this.previewFadeTimer = window.setTimeout(() => {
        if (this.menuAudioStarted) {
          ctx.audioCompositor.applyPreset(MENU_WHISPER_PRESET, 3);
        }
      }, 4000);
    });

    log.info('screen', 'SessionSelectorScreen entered');
  }

  exit(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.previewFadeTimer) { clearTimeout(this.previewFadeTimer); this.previewFadeTimer = null; }
    this.selector?.dispose?.();
    this.selector = null;
    this.ctx = null;
    log.info('screen', 'SessionSelectorScreen exited');
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    const s = this.ctx.settings.current;

    const rawDt = this.lastAnimTime > 0 ? time - this.lastAnimTime : 1 / 60;
    const dt = Math.min(rawDt, 0.1);
    this.lastAnimTime = time;
    this.spiralAngle += dt * 0.5 * s.spiralSpeedMult * 0.5;

    this.ctx.breath.update(time);

    if (this.selector) {
      this.selector.setDepth(s.menuDepth);
      this.selector.setScale(s.menuScale);
      this.selector.update(time);
    }


    // Tunnel settings
    this.ctx.tunnelLayer.setSettings({
      tunnelSpeed: s.tunnelSpeed, tunnelWidth: s.tunnelWidth,
      breathExpansion: s.breathExpansion, spiralSpeedMult: s.spiralSpeedMult,
    });
    this.ctx.tunnelLayer.setPortalColors(this.targetColors.c1, this.targetColors.c2, 1);
    this.ctx.cameraLayer.setCameraSway(s.cameraSway);

    // Render passes handled by main renderLoop()
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }

  // ── Private ──

  private async startMenuAudio(ctx: ScreenContext): Promise<void> {
    if (this.menuAudioStarted) return;
    try {
      resumeAudioFromGesture(ctx.audio);
      await ensureAudioCompositor(ctx.audio, ctx.audioCompositor);
      ctx.audioCompositor.setMasterVolume(ctx.settings.current.ambientVolume);
      if (!ctx.audioCompositor['isPlaying']) {
        ctx.audioCompositor.start(MENU_AUDIO_PRESET);
      } else {
        ctx.audioCompositor.applyPreset(MENU_AUDIO_PRESET, 2);
      }
      this.menuAudioStarted = true;
      playOpeningTone(ctx.audio);

      // Fade to whisper after chime settles
      setTimeout(() => {
        if (this.menuAudioStarted && this.ctx) {
          ctx.audioCompositor.applyPreset(MENU_WHISPER_PRESET, 6);
        }
      }, 8000);
    } catch (e) {
      log.warn('screen', 'Menu audio failed', e);
    }
  }

  private async onSessionSelect(selectorSession: SelectorSession): Promise<void> {
    if (!this.ctx) return;
    resumeAudioFromGesture(this.ctx.audio);

    // Fetch full session config from store
    let session: SessionConfig | null = null;

    // Try store first
    session = await sessionStore.getSession(selectorSession.id);

    // Fallback: try hardcoded sessions
    if (!session) {
      try {
        const { sessions } = await import('../sessions/index');
        session = sessions.find(s => s.id === selectorSession.id) ?? null;
      } catch { /* no hardcoded sessions */ }
    }

    if (!session) {
      log.warn('session-selector', `Failed to load session: ${selectorSession.id}`);
      return;
    }

    const { SessionScreen } = await import('./session');
    this.ctx.screenManager.replace(new SessionScreen(session));
  }

  private buildSelectorSessions(): SelectorSession[] {
    // Try store summaries first
    const summaries = sessionStore.getSummaries();
    if (summaries.length > 0) {
      return summaries.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        icon: s.icon,
        contentWarning: s.contentWarning,
        theme: {
          primaryColor: s.themePreview.primaryColor,
          secondaryColor: s.themePreview.secondaryColor,
          accentColor: s.themePreview.accentColor,
          bgColor: s.themePreview.bgColor,
          particleColor: s.themePreview.particleColor,
          textColor: s.themePreview.textColor,
          textGlow: s.themePreview.textGlow,
          tunnelShape: 0,
        },
      }));
    }

    // Fallback: empty (hardcoded sessions registered in store cache by main.ts)
    return [];
  }
}
