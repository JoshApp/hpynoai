/**
 * SessionScreen — active hypnosis session.
 *
 * Owns: timeline lifecycle, playback controls, session tick, session render.
 * The persistent world (tunnel, presence, audio) is configured via presets.
 */

import * as THREE from 'three';
import type { Screen, ScreenContext } from '../screen';
import type { SessionConfig } from '../session';
import type { AudioPreset } from '../audio-compositor';
import type { WorldInputs } from '../compositor/types';
import { buildSessionAudioPreset } from '../audio-presets';
import { deriveSessionFrame } from '../session-frame';
import { buildWorldInputs } from '../world-inputs';
import { resumeAudioFromGesture, ensureAudioCompositor } from './audio-helpers';
import { hashSeed } from '../audio-compositor';
import { startAutoSave, saveProgress, clearProgress } from '../session-persistence';

import { acquireWakeLock, releaseWakeLock, registerMediaSession, clearMediaSession, startSilentAudioKeepAlive, stopSilentAudioKeepAlive } from '../wakelock';
import { log } from '../logger';

export class SessionScreen implements Screen {
  readonly name = 'session';

  private session: SessionConfig;
  private ctx: ScreenContext | null = null;
  private unsubs: Array<() => void> = [];
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private lastTick: import('../timeline').TimelineState | null = null;

  // Render state
  private renderBlockIndex = -1;
  private lastAnimTime = 0;
  private renderTime = 0;
  private lastStageIndex = -1;
  private completionHandled = false;
  private stopAutoSave: (() => void) | null = null;
  private startPosition = 0;
  private startPaused = false;

  constructor(session: SessionConfig, opts?: { resumePosition?: number; startPaused?: boolean }) {
    this.session = session;
    this.startPosition = opts?.resumePosition ?? 0;
    this.startPaused = opts?.startPaused ?? false;
  }

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;
    log.info('session', `Starting: ${this.session.name}`);

    ctx.machine.transition('transitioning', { sessionId: this.session.id });
    ctx.bus.emit('session:starting', { session: this.session });

    // Reset state
    this.completionHandled = false;
    this.lastStageIndex = -1;
    this.renderBlockIndex = -1;

    // Theme (immediate — visual)
    ctx.tunnelLayer.applyTheme(this.session.theme);
    ctx.particlesLayer.setColor(...this.session.theme.particleColor);
    ctx.presenceActor.setColors(this.session.theme.accentColor);
    ctx.textActor.setColors(this.session.theme.textColor, this.session.theme.textGlow);
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'narrator' } });

    // Input handlers (immediate — always ready)
    this.unsubs.push(ctx.bus.on('input:back', () => {
      if (ctx.screenManager.isTransitioning) return;
      this.returnToMenu();
    }));

    // Pause/resume on confirm (space/enter/tap)
    const handleToggle = () => {
      if (!ctx.timeline.started) return;
      if (ctx.timeline.paused) {
        const tlState = ctx.timeline.update();
        if (tlState?.atBoundary) {
          ctx.audioClipActor.setDirective({ type: 'audio-clip', directive: { clip: 'gate_yes' } });
          ctx.audioCompositor.silenceDip(1.5, 5);
        }
        ctx.playbackControls.togglePause();
      } else {
        ctx.playbackControls.togglePause();
      }
    };
    this.unsubs.push(ctx.bus.on('input:confirm', handleToggle));

    // Prevent UI buttons from stealing keyboard focus — keeps Space/Enter
    // working for pause/resume even after clicking settings/fullscreen.
    const blurButtons = () => {
      if (document.activeElement instanceof HTMLButtonElement) {
        document.activeElement.blur();
      }
    };
    // Blur after any click so Space always goes to our handler
    document.addEventListener('click', blurButtons);
    this.unsubs.push(() => document.removeEventListener('click', blurButtons));

    // Wakelock (sync, from user gesture context)
    resumeAudioFromGesture(ctx.audio);
    acquireWakeLock();
    registerMediaSession(this.session.name);
    startSilentAudioKeepAlive();
    ctx.hud.setMode('session');

    // Async init — audio, manifest, timeline (runs in background)
    this.initSession(ctx).catch(e => log.warn('session', 'Init failed', e));
  }

  /** Async init — audio compositor, manifest, timeline. Called from enter(). */
  private async initSession(ctx: ScreenContext): Promise<void> {
    // Wait for audio + narration manifest
    await Promise.all([ctx.audio.init(), ctx.narration.waitForManifest()]);
    if (!this.ctx) return; // screen was exited while waiting

    // Audio compositor
    try {
      await ensureAudioCompositor(ctx.audio, ctx.audioCompositor);
      if (!ctx.audioCompositor['isPlaying']) ctx.audioCompositor.start();

      const { SequencerActor } = await import('../audio-compositor/actors/sequencer');
      const sequencer = new SequencerActor(hashSeed(this.session.id));
      const padLayer = ctx.audioCompositor.getLayer('pad');
      if (padLayer) {
        sequencer.onChordChange((chord: number[]) => {
          (padLayer as import('../audio-compositor/layers/pad').PadLayer).applyPreset({
            ...ctx.audioCompositor['currentPreset'],
            pad: { ...ctx.audioCompositor['currentPreset'].pad, chord },
          }, 3);
        });
      }
      ctx.audioCompositor.addLayer(sequencer);
    } catch (e) {
      log.warn('session', 'Audio compositor setup failed', e);
    }

    if (!this.ctx) return; // exited while waiting

    // Audio preset
    const rootNotes: Record<string, number> = { relax: 48, sleep: 45, focus: 52, surrender: 50 };
    const preset = buildSessionAudioPreset(this.session, ctx.settings.current.binauralVolume, rootNotes[this.session.id] ?? 48);
    ctx.audioCompositor.applyPreset(preset, 2);
    ctx.audioCompositor.setMasterVolume(ctx.settings.current.ambientVolume);

    // Build + start timeline
    ctx.timeline.build(
      this.session.stages,
      (name) => ctx.narration.hasStageAudio(name),
      (name) => ctx.narration.getStageAudioDuration(name),
    );
    ctx.timebar.buildBlocks();
    ctx.devMode.rebuildStageButtons();

    ctx.machine.transition('session');

    // Start playback through MediaController (atomic, handles audio binding)
    ctx.mediaController.play();
    if (this.startPosition > 0) {
      await ctx.mediaController.seek(this.startPosition);
      log.info('session', `Resumed at ${this.startPosition.toFixed(1)}s`);
    }
    if (this.startPaused) {
      await ctx.mediaController.pause();
      log.info('session', 'Started paused (HMR restore)');
    }

    // Auto-save
    this.stopAutoSave = startAutoSave(() => {
      if (!ctx.timeline.started) return null;
      return { sessionId: this.session.id, position: ctx.timeline.position, stageIndex: ctx.timeline.currentIndex };
    });

    // Tick interval — starts after timeline is ready
    this.tickInterval = setInterval(() => this.sessionTick(), 1000 / 60);

    log.info('session', 'Session fully initialized');
  }

  exit(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    if (this.stopAutoSave) { this.stopAutoSave(); this.stopAutoSave = null; }

    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }

    ctx.hud.setMode('menu');
    releaseWakeLock();
    clearMediaSession();
    stopSilentAudioKeepAlive();

    ctx.mediaController.stop();
    ctx.interactions.clear();
    ctx.textActor.setDirective({ type: 'text', directive: { mode: 'clear' } });

    ctx.bus.emit('session:ended', {});
    this.ctx = null;
    log.info('session', 'Session exited');
  }

  tick(inputs: WorldInputs, dt: number): void {
    // Tick is driven by our own setInterval, not the screen manager
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const s = ctx.settings.current;
    const tlState = this.lastTick;
    const intensity = tlState?.intensity ?? 0.12;

    const rawDt = this.lastAnimTime > 0 ? time - this.lastAnimTime : 1 / 60;
    const dt = Math.min(rawDt, 0.1);
    this.lastAnimTime = time;
    this.renderTime += dt;

    // Block change — visual only
    if (tlState) {
      if (tlState.seeked) {
        ctx.textActor.display.reset();
      }

      const renderBlockChanged = tlState.blockIndex !== this.renderBlockIndex;
      if (renderBlockChanged) {
        this.renderBlockIndex = tlState.blockIndex;
        // Presence mode driven by directive
        ctx.presenceActor.setDirective({
          type: 'presence',
          directive: { role: tlState.presenceMode === 'breathe' ? 'breathing-companion' : 'narrator' },
        });
        ctx.machine.setStageIndex(tlState.block.stageIndex);
      }

      // Text display — driven per-frame here (needs live audioRef sync).
      // Non-audio text (cue/prompt/tts) handled by sessionTick() compositor directives.
      const narLine = ctx.narration.displayLine;
      if (narLine && ctx.narration.isPlayingStage) {
        ctx.textActor.display.set(narLine.text, 'focus', {
          words: narLine.words as Array<{ word: string; start: number; end: number }>,
          audioRef: ctx.narration.stageAudioElement,
          audioLineStart: narLine.startTime,
        });
      } else if (!ctx.narration.isPlayingStage && tlState.text) {
        ctx.textActor.display.set(tlState.text, tlState.textStyle, { depth: tlState.slotDepth ?? undefined });
      } else if (!narLine && !ctx.narration.isPlayingStage) {
        ctx.textActor.display.set(null);
      }
      if (tlState.slotDepth !== null) ctx.textActor.display.setSlotDepth(tlState.slotDepth);
    }

    // Subsystem updates
    ctx.breath.update(time);
    ctx.textActor.setSettings({ startZ: s.narrationStartZ, endZ: s.narrationEndZ, scale: s.narrationScale });
    ctx.tunnelLayer.setSettings({ tunnelSpeed: s.tunnelSpeed, tunnelWidth: s.tunnelWidth, breathExpansion: s.breathExpansion, spiralSpeedMult: s.spiralSpeedMult });
    ctx.tunnelLayer.setMouse(0, 0); // TODO: mouse tracking
    ctx.cameraLayer.setCameraSway(s.cameraSway);
    ctx.interactions.setDepth(s.interactionDepth);
    ctx.interactions.setScale(s.interactionScale);
    ctx.interactions.update(time, intensity, ctx.breath.value);
    ctx.devMode.update();

    // Presence + wisp audio — driven by PresenceActor via compositor.update() in tick
    // Wisp audio position sync
    const wispAudio = ctx.audioCompositor.getLayer('wisp-audio');
    if (wispAudio && 'setPosition' in wispAudio) {
      const p = ctx.presence.mesh.position;
      (wispAudio as { setPosition: (x: number, y: number, z: number) => void }).setPosition(p.x, p.y, p.z);
    }

    // Render passes handled by main renderLoop()

    ctx.machine.setStageIndex(ctx.timeline.currentIndex);
    ctx.timebar.update();
    ctx.hud.update();
  }

  getAudioPreset(): Partial<AudioPreset> | null {
    return null; // Applied manually in enter()
  }

  // ── Private ──

  private sessionTick(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    // 1. Get state (fresh tick or last known)
    const tlState = ctx.mediaController.tick();
    if (tlState) this.lastTick = tlState;
    const state = tlState ?? this.lastTick;
    if (!state) return;

    // 2. Derive frame (pure — no side effects)
    const frame = deriveSessionFrame({
      state,
      isFreshTick: tlState !== null,
      fadeAmount: ctx.transition.state.fadeAmount,
      audioProfile: this.session.audio,
      binauralVolume: ctx.settings.current.binauralVolume,
      lastStageIndex: this.lastStageIndex,
      isNarrationPlaying: ctx.narration.isPlayingStage,
      isPlaying: ctx.mediaController.isPlaying,
    });
    this.lastStageIndex = frame.newStageIndex;

    // 3. Apply directives (independent — each guarded, no cascading failures)
    ctx.compositor.configure(frame.config);

    if (frame.audioPreset) {
      ctx.audioCompositor.applyPreset(frame.audioPreset.preset, frame.audioPreset.rampTime);
      if (frame.audioPreset.silenceDip) ctx.audioCompositor.silenceDip(2, 6);
    }

    if (frame.speakText) {
      ctx.narration.speakText(frame.speakText);
    }

    if (frame.pauseAtBoundary) {
      ctx.mediaController.pause();
      ctx.audioClipActor.setDirective({ type: 'audio-clip', directive: { clip: 'gate_deeper' } });
    }

    // 4. Always update subsystems (never skipped, keeps visuals/audio alive during pause)
    const inputs = buildWorldInputs({
      timeline: state,
      analyzer: ctx.audio.analyzer,
      voiceEnergy: ctx.narration.state.voiceEnergy,
      breath: ctx.breath,
      interactionShader: ctx.interactions.shaderState,
      renderTime: this.renderTime, dt: 1 / 60,
    });
    ctx.compositor.update(inputs, 1 / 60);
    ctx.audioCompositor.update(inputs, 1 / 60);
    ctx.narration.update();

    // 5. Completion check
    if (ctx.mediaController.completionFired && !this.completionHandled) {
      if (!ctx.transition.isActive) {
        this.completionHandled = true;
        this.endExperience();
      }
    }
  }

  private async endExperience(): Promise<void> {
    if (!this.ctx) return;
    clearProgress(); // session completed — no resume needed
    const { SessionEndScreen } = await import('./session-end');
    this.ctx.machine.transition('ending');

    // Build summary from session data
    const duration = this.ctx.timeline.position;
    const summary = {
      sessionName: this.session.name,
      sessionIcon: this.session.icon,
      durationSeconds: duration,
      stagesCompleted: this.session.stages.length,
      totalStages: this.session.stages.length,
    };

    this.ctx.screenManager.replace(new SessionEndScreen(summary), {
      fadeOutMs: 3000, holdMs: 500, fadeInMs: 2000,
    });
  }

  private async returnToMenu(): Promise<void> {
    if (!this.ctx) return;
    const { SessionSelectorScreen } = await import('./session-selector');
    this.ctx.machine.transition('ending');
    this.ctx.screenManager.reset(new SessionSelectorScreen({ skipIntro: true }), {
      fadeOutMs: 1200, holdMs: 300, fadeInMs: 1500,
    });
  }
}
