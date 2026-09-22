/**
 * SessionDirector — the glue between a Player and the Engine.
 *
 * Player events (cues, gates, stages) become world changes: presets by
 * depth, wisp anchors, breath patterns, triggers, narration text. It also
 * feeds the engine's per-frame inputs from the player and keeps the
 * player ticking in listen mode when rAF is throttled.
 */

import type { Engine } from '@engine/engine';
import { sessionPreset, idlePreset } from '@engine/world/palette';
import { NarrationText } from '@engine/text/narration-text';
import type { WorldInputs, Preset } from '@engine/world/types';
import { Player, type PlayMode } from '@player/player';
import type { LoadedPackage } from '@content/loader';
import { resolveAsset } from '@content/loader';
import { setupMediaSession, updatePlaybackState } from '@player/media-session';
import { saveProgress, clearProgress } from '@player/persistence';
import type { CueEvent } from '@player/cues';
import { domMediaFactory, type MediaFactory, type MediaLike } from '@player/media';

export interface DirectorOptions {
  voiceVolume: number;
  bedVolume: number;
  showText: boolean;
  textMode: 'word' | 'line';
  textLead: number;
  textScale: number;
  reduceFlash: boolean;
  haptic: (pattern?: number | number[]) => void;
}

export interface DirectorSnapshot {
  state: Player['state'];
  position: number;
  duration: number;
  gate: { prompt: string; remaining: number; total: number } | null;
  stage: string;
  breathing: boolean;
  intensity: number;
}

export class SessionDirector {
  readonly player: Player;
  readonly mode: PlayMode;
  private readonly engine: Engine;
  private readonly text: NarrationText;
  private opts: DirectorOptions;
  private unsubs: Array<() => void> = [];
  private breathBandActive = 0;
  private breathBandFill = 0;
  private breathActive = false;
  private lastDepth = -1;
  private screenOff = false;
  private ticker = 0;
  private saveTimer = 0;
  private wakeLock: WakeLockSentinel | null = null;
  private lastInhaleStage: string = '';
  readonly snapshot: DirectorSnapshot;

  constructor(engine: Engine, loaded: LoadedPackage, mode: PlayMode, opts: DirectorOptions) {
    this.engine = engine;
    this.mode = mode;
    this.opts = opts;
    const media: MediaFactory = mode === 'watch'
      ? { ...domMediaFactory, attach: (el: MediaLike, role) => engine.audio.attach(el as unknown as HTMLMediaElement, role) }
      : domMediaFactory;
    this.player = new Player({ pkg: loaded.pkg, baseUrl: loaded.baseUrl, mode, media, voiceVolume: opts.voiceVolume, bedVolume: opts.bedVolume });
    this.text = new NarrationText(engine.world.overlayScene);
    this.text.setScale(opts.textScale);
    this.snapshot = { state: 'idle', position: 0, duration: this.player.duration, gate: null, stage: '', breathing: false, intensity: 0.1 };

    const theme = loaded.pkg.theme;
    if (theme?.wisp) engine.world.wisp.setColors(theme.wisp);

    this.unsubs.push(
      this.player.events.on('cue', ev => this.onCue(ev)),
      this.player.events.on('gate', ({ phase }) => {
        if (phase === 'answered') { engine.world.wisp.pulse(1.5); engine.world.wisp.colorPulse([1, 0.8, 0.85], 0.8); opts.haptic([10, 40, 20]); }
        if (phase !== 'open') this.text.clear();
      }),
      this.player.events.on('state', s => {
        updatePlaybackState(s === 'playing' ? 'playing' : s === 'paused' ? 'paused' : 'none', this.player.position, this.player.duration);
        if (s === 'ended') clearProgress();
      }),
      this.player.events.on('ended', () => { engine.world.configure(idlePreset, { duration: 0, settleSpeed: 0.4 }); engine.world.wisp.enterIdle(); }),
    );

    this.unsubs.push(setupMediaSession(
      { title: loaded.pkg.title, artist: 'HPYNO', artwork: resolveAsset(import.meta.env.BASE_URL, 'icon-512.png') },
      {
        play: () => { void this.player.resume(); },
        pause: () => this.player.pause(),
        stop: () => this.player.pause(),
        seekTo: (s) => { void this.player.seek(s); },
        seekBy: (d) => { void this.player.seekBy(d); },
        next: () => { void this.answer(); },
      },
    ));

    engine.setInputSource(inp => this.feed(inp));
  }

  /**
   * Call synchronously inside the tap that starts the session. Everything
   * that needs the gesture (AudioContext creation, media element play())
   * happens before the first await.
   */
  start(position = 0): Promise<void> {
    if (this.mode === 'watch') {
      this.engine.audio.unlockSync();
      this.engine.setFrameMode('active');
      void this.acquireWakeLock();
    } else {
      this.engine.setFrameMode('idle');
    }
    this.applyTheme();
    this.engine.world.wisp.enterSession();
    const playing = this.player.play(position); // sync until its first await
    this.started = true;
    return playing.then(() => this.afterStart());
  }
  private started = false;
  get hasStarted(): boolean { return this.started; }

  private afterStart(): void {
    if (this.mode === 'listen') {
      this.ticker = window.setInterval(() => this.player.tick(0.25), 250);
    }
    this.saveTimer = window.setInterval(() => this.persist(), 5000);
  }

  private applyTheme(): void {
    const theme = this.player.pkg.theme;
    const preset = sessionPreset(this.player.intensity);
    if (theme?.colors && preset.tunnel) preset.tunnel.colors = { ...preset.tunnel.colors!, ...theme.colors };
    if (theme?.shape !== undefined && preset.tunnel) preset.tunnel.shape = theme.shape;
    this.engine.world.configure(preset, { duration: 0, settleSpeed: 0.5 });
  }

  setOptions(o: Partial<DirectorOptions>): void {
    const modeChanged = o.textMode !== undefined && o.textMode !== this.opts.textMode;
    this.opts = { ...this.opts, ...o };
    if (modeChanged) this.text.clear();
    if (o.voiceVolume !== undefined) this.player.voiceVolume = o.voiceVolume;
    if (o.bedVolume !== undefined) this.player.bedVolume = o.bedVolume;
    if (o.textScale !== undefined) this.text.setScale(o.textScale);
    if (o.showText === false) this.text.clear();
  }

  setScreenOff(off: boolean): void {
    this.screenOff = off;
    this.engine.world.configure({ fade: { opacity: off ? 0.96 : 0 } }, { duration: 0, settleSpeed: 2.5 });
    clearTimeout(this.idleTimer);
    if (off || this.mode === 'listen') {
      // keep full frame rate until the fade has settled, then idle
      this.engine.setFrameMode('active');
      this.idleTimer = window.setTimeout(() => { if (this.screenOff || this.mode === 'listen') this.engine.setFrameMode('idle'); }, 1800);
    } else {
      this.engine.setFrameMode('active');
    }
  }
  private idleTimer = 0;

  get isScreenOff(): boolean { return this.screenOff; }

  async answer(): Promise<boolean> { return this.player.answerGate(); }
  async toggle(): Promise<void> { await this.player.toggle(); }
  async seek(t: number): Promise<void> { await this.player.seek(t); }

  private feed(inp: WorldInputs): void {
    const p = this.player;
    if (this.mode === 'watch') p.tick(inp.dt);

    const depth = p.intensity;
    if (Math.abs(depth - this.lastDepth) > 0.005 && (p.state === 'playing' || p.state === 'paused')) {
      this.lastDepth = depth;
      const preset: Preset = sessionPreset(depth);
      const theme = p.pkg.theme;
      if (theme?.colors && preset.tunnel) preset.tunnel.colors = { ...preset.tunnel.colors!, ...theme.colors };
      if (theme?.shape !== undefined && preset.tunnel) preset.tunnel.shape = theme.shape;
      delete preset.fade; // owned by setScreenOff / triggers
      // Continuous drive: update channel targets with a slow settle. Never restart a blended transition per frame.
      this.engine.world.configure(preset, { duration: 0, settleSpeed: 0.5 });
    }
    inp.intensity = depth;

    // Breath band overlay during guided breathing
    const target = this.breathActive ? 1 : 0;
    this.breathBandActive += (target - this.breathBandActive) * (1 - Math.exp(-2 * inp.dt));
    this.breathBandFill = inp.breath.value;
    inp.breathBand.active = this.breathBandActive;
    inp.breathBand.fill = this.breathBandFill;
    inp.breathBand.progress = this.breathBandActive;

    // Haptic tick on inhale start during guided breathing
    if (this.breathActive && inp.breath.stage === 'inhale' && this.lastInhaleStage !== 'inhale') this.opts.haptic(8);
    this.lastInhaleStage = inp.breath.stage;

    // Narration text
    if (this.mode === 'watch' && this.opts.showText && !this.screenOff && p.state === 'playing') {
      const g = p.gate;
      if (g && !g.answered) this.text.prompt(g.cue.prompt);
      else {
        const r = p.textAt(p.position + this.opts.textLead);
        if (this.opts.textMode === 'line') {
          if (r.line) {
            const w = r.wordIndex >= 0 ? r.line.absWords[r.wordIndex] : undefined;
            const prog = w ? (p.position + this.opts.textLead - w.s) / Math.max(0.05, w.e - w.s) : 0;
            this.text.karaoke(r.line.absWords.map(x => x.w), r.wordIndex, prog);
          } else this.text.clear();
        } else {
          const w = r.line && r.wordIndex >= 0 ? r.line.absWords[r.wordIndex] : undefined;
          if (w) this.text.word(w.w); else if (!r.line) this.text.clear();
        }
      }
    } else if (p.state !== 'playing') {
      // keep whatever is shown, fade handled by NarrationText
    }
    this.text.update(inp.dt, inp.breath.value);

    // Snapshot for UI
    const s = this.snapshot;
    s.state = p.state; s.position = p.position; s.duration = p.duration; s.stage = p.stage.name;
    s.breathing = this.breathActive; s.intensity = depth;
    const g = p.gate;
    s.gate = g && !g.answered ? { prompt: g.cue.prompt, remaining: Math.max(0, g.deadline - p.position), total: g.cue.window } : null;
  }

  private onCue(ev: CueEvent): void {
    const c = ev.cue;
    const w = this.engine.world;
    switch (c.type) {
      case 'anchor':
        if (ev.kind !== 'enter') break;
        if (c.mode === 'settle') w.wisp.enterSession();
        else if (c.mode === 'hidden') w.wisp.hide();
        else w.wisp.transitionTo(c.mode, { duration: 2 });
        break;
      case 'pattern':
        if (ev.kind === 'enter') this.engine.breath.setPattern(c.pattern);
        break;
      case 'breath':
        if (ev.kind === 'enter') { this.engine.breath.setPattern(c.pattern); this.breathActive = true; w.wisp.transitionTo('breathe', { duration: 1.5 }); }
        else this.breathActive = false;
        break;
      case 'trigger':
        if (ev.kind !== 'enter' || this.mode !== 'watch' || this.screenOff) break;
        if (c.kind === 'drop') { w.fade.drop(this.opts.reduceFlash ? 2.2 : 1.4, 'black'); this.engine.renderer.clearTrails(); }
        else if (c.kind === 'bloom') { if (!this.opts.reduceFlash) w.fade.drop(0.55, 'white'); w.wisp.pulse(1.7); w.wisp.colorPulse([1, 0.85, 0.9], 1); }
        else if (c.kind === 'snap') { w.wisp.pulse(1.3); w.wisp.colorPulse([1, 0.6, 0.7], 0.8); this.opts.haptic(20); }
        break;
      default: break;
    }
  }

  private persist(): void {
    const p = this.player;
    if (p.state === 'playing' || p.state === 'paused') saveProgress({ sessionId: p.pkg.id, position: p.position, mode: this.mode });
  }

  private async acquireWakeLock(): Promise<void> {
    try { this.wakeLock = await navigator.wakeLock?.request('screen') ?? null; } catch { this.wakeLock = null; }
  }

  dispose(): void {
    this.persist();
    clearInterval(this.ticker);
    clearInterval(this.saveTimer);
    for (const u of this.unsubs) u();
    this.player.dispose();
    this.text.dispose();
    this.wakeLock?.release().catch(() => {});
    this.engine.setInputSource(null);
    this.engine.inputs.intensity = 0.12;
    this.engine.inputs.breathBand.active = 0;
    this.engine.inputs.breathBand.fill = 0;
    this.engine.inputs.breathBand.progress = 0;
    clearTimeout(this.idleTimer);
    this.engine.setFrameMode('active');
    this.engine.world.configure(idlePreset, { duration: 0, settleSpeed: 0.6 });
    this.engine.world.wisp.enterIdle();
    updatePlaybackState('none');
  }
}
