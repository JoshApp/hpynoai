/**
 * Player — the one-clock session transport.
 *
 * Voice stages are contiguous audio files; the position is
 * `stageStart + voiceElement.currentTime`. The ambient bed loops on its own
 * element. Cues are dispatched from the position. Gates never block: the
 * scripted silent window is part of the voice file, and answering early
 * seeks past it.
 *
 * Framework-free and DOM-optional (MediaFactory is injectable) so the core
 * can be tested with a fake clock.
 */

import type { Cue, GateCue, SessionPackage, StageTrack } from '@content/schema';
import { stageStarts, totalDuration } from '@content/schema';
import { CueScheduler, type CueEvent } from './cues';
import { TextTrack, type TextReading } from './text-track';
import { Emitter } from './emitter';
import { canPlayOpus, domMediaFactory, type MediaFactory, type MediaLike } from './media';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';
export type PlayMode = 'watch' | 'listen';

export interface ActiveGate {
  cue: GateCue;
  /** absolute position at which the window closes */
  deadline: number;
  answered: boolean;
}

export interface PlayerEvents extends Record<string, unknown> {
  state: PlayerState;
  cue: CueEvent;
  stage: { index: number; stage: StageTrack };
  gate: { gate: ActiveGate; phase: 'open' | 'answered' | 'closed' };
  ended: undefined;
  error: { message: string; cause?: unknown };
}

export interface PlayerOptions {
  pkg: SessionPackage;
  baseUrl: string;
  mode: PlayMode;
  media?: MediaFactory;
  voiceVolume?: number;
  bedVolume?: number;
  /** Prebuffer the next stage this many seconds before the current one ends. */
  prebufferLead?: number;
}

export class Player {
  readonly pkg: SessionPackage;
  readonly mode: PlayMode;
  readonly duration: number;
  readonly text: TextTrack;
  readonly events = new Emitter<PlayerEvents>();

  private readonly starts: number[];
  private readonly media: MediaFactory;
  private readonly baseUrl: string;
  private readonly cues: CueScheduler;
  private readonly lead: number;

  private _state: PlayerState = 'idle';
  private stageIdx = 0;
  private voice: MediaLike | null = null;
  private next: { index: number; el: MediaLike } | null = null;
  private bed: MediaLike | null = null;
  private _voiceVolume: number;
  private _bedVolume: number;
  private _gate: ActiveGate | null = null;
  private lastPosition = 0;
  private epoch = 0;
  private _intensity = 0.1;
  private intensityTarget = 0.1;
  private intensityRate = 0;

  constructor(opts: PlayerOptions) {
    this.pkg = opts.pkg;
    this.mode = opts.mode;
    this.baseUrl = opts.baseUrl;
    this.media = opts.media ?? domMediaFactory;
    this.starts = stageStarts(opts.pkg);
    this.duration = totalDuration(opts.pkg);
    this.cues = new CueScheduler(opts.pkg.cues);
    this.text = new TextTrack(opts.pkg);
    this._voiceVolume = opts.voiceVolume ?? 1;
    this._bedVolume = opts.bedVolume ?? 0.6;
    this.lead = opts.prebufferLead ?? 8;
  }

  // ── Read state ──

  get state(): PlayerState { return this._state; }
  get isPlaying(): boolean { return this._state === 'playing'; }
  get stageIndex(): number { return this.stageIdx; }
  get stage(): StageTrack { return this.pkg.audio.stages[this.stageIdx]!; }
  get gate(): ActiveGate | null { return this._gate; }
  /** Session depth 0..1, eased by intensity cues. */
  get intensity(): number { return this._intensity; }

  get position(): number {
    if (!this.voice) return this.lastPosition;
    return (this.starts[this.stageIdx] ?? 0) + this.voice.currentTime;
  }

  get progress(): number { return this.duration > 0 ? Math.min(1, this.position / this.duration) : 0; }

  textAt(position = this.position): TextReading { return this.text.at(position); }

  // ── Volumes ──

  set voiceVolume(v: number) { this._voiceVolume = v; if (this.voice) this.voice.volume = v; if (this.next) this.next.el.volume = v; }
  get voiceVolume(): number { return this._voiceVolume; }
  set bedVolume(v: number) { this._bedVolume = v; if (this.bed) this.bed.volume = v * this.bedGain(); }
  get bedVolume(): number { return this._bedVolume; }

  private bedGain(): number {
    const db = this.pkg.audio.bed?.gainDb ?? 0;
    return Math.pow(10, db / 20);
  }

  // ── Transport ──

  /** Start from `position` (seconds). Must be called from a user gesture on the first play. */
  async play(position = 0): Promise<void> {
    if (this._state === 'playing') return;
    const epoch = ++this.epoch;
    this.setState('loading');
    this.lastPosition = Math.max(0, Math.min(position, Math.max(0, this.duration - 0.05)));

    if (this.pkg.audio.bed && !this.bed) {
      const b = this.pkg.audio.bed;
      this.bed = this.media.create(this.url(b.file, b.fileMp3));
      this.bed.loop = b.loop;
      this.bed.volume = this._bedVolume * this.bedGain();
      this.media.attach?.(this.bed, 'bed');
    }
    if (this.bed?.paused) this.bed.play().catch(e => this.events.emit('error', { message: 'bed play() rejected', cause: e }));

    await this.enterStageAt(this.lastPosition, epoch);
    if (epoch !== this.epoch) return;
    for (const ev of this.cues.seek(this.lastPosition)) this.handleCue(ev);
    this.setState('playing');
  }

  pause(): void {
    if (this._state !== 'playing') return;
    this.lastPosition = this.position;
    this.voice?.pause();
    this.bed?.pause();
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (this._state !== 'paused') return;
    this.bed?.play().catch(() => {});
    try { await this.voice?.play(); }
    catch (e) { this.events.emit('error', { message: 'voice play() rejected on resume', cause: e }); }
    this.setState('playing');
  }

  async toggle(): Promise<void> {
    if (this._state === 'playing') this.pause();
    else if (this._state === 'paused') await this.resume();
  }

  async seek(position: number): Promise<void> {
    if (this._state === 'idle' || this._state === 'loading') return;
    const wasPlaying = this._state === 'playing';
    const epoch = ++this.epoch;
    const target = Math.max(0, Math.min(position, Math.max(0, this.duration - 0.05)));
    const idx = this.stageIndexFor(target);
    if (idx === this.stageIdx && this.voice) {
      this.voice.currentTime = target - (this.starts[idx] ?? 0);
    } else {
      await this.enterStageAt(target, epoch, wasPlaying);
      if (epoch !== this.epoch) return;
    }
    this.lastPosition = target;
    if (this._gate) this.closeGate('closed');
    for (const ev of this.cues.seek(target)) this.handleCue(ev);
    if (!wasPlaying) { this.voice?.pause(); }
  }

  async seekBy(delta: number): Promise<void> { await this.seek(this.position + delta); }

  stop(): void {
    this.epoch++;
    this.lastPosition = this.position;
    this.destroyVoice();
    if (this.bed) { this.bed.pause(); this.bed.src = ''; this.bed.load(); this.bed = null; }
    if (this._gate) this.closeGate('closed');
    this.setState('idle');
  }

  /** The user said yes. Skips the rest of the scripted silence. */
  async answerGate(): Promise<boolean> {
    const g = this._gate;
    if (!g || g.answered) return false;
    g.answered = true;
    this.events.emit('gate', { gate: g, phase: 'answered' });
    const skipTo = g.cue.t + g.cue.window;
    for (const ev of this.cues.release(g.cue)) this.handleCue(ev);
    this._gate = null;
    if (this.position < skipTo - 0.25) {
      const wasPlaying = this._state === 'playing';
      const idx = this.stageIndexFor(skipTo);
      if (idx === this.stageIdx && this.voice) this.voice.currentTime = skipTo - (this.starts[idx] ?? 0);
      else await this.enterStageAt(skipTo, ++this.epoch, wasPlaying);
      this.lastPosition = skipTo;
    }
    return true;
  }

  // ── Per-frame ──

  /** Advance cues and gates. Call once per frame (or per timer tick in listen mode). */
  tick(dt: number): void {
    if (this._state !== 'playing' && this._state !== 'paused') return;
    const pos = this.position;
    if (this._state === 'playing') {
      this.lastPosition = pos;
      for (const ev of this.cues.tick(pos)) this.handleCue(ev);
      if (this._gate && !this._gate.answered && pos >= this._gate.deadline) this.closeGate('closed');
      this.maybePrebuffer(pos);
    }
    if (this.intensityRate > 0 && this._intensity !== this.intensityTarget) {
      const step = this.intensityRate * dt;
      const d = this.intensityTarget - this._intensity;
      this._intensity = Math.abs(d) <= step ? this.intensityTarget : this._intensity + Math.sign(d) * step;
    }
  }

  // ── Internals ──

  private url(file: string, mp3?: string): string {
    const opus = this.media.canPlayOpus ? this.media.canPlayOpus() : canPlayOpusSafe();
    const pick = (!file.endsWith('.webm') || opus) ? file : (mp3 ?? file);
    return /^(https?:)?\/\//.test(pick) || pick.startsWith('/') ? pick : this.baseUrl + pick;
  }

  private stageIndexFor(position: number): number {
    let idx = 0;
    for (let i = 0; i < this.starts.length; i++) if (position >= (this.starts[i] ?? 0)) idx = i;
    return idx;
  }

  private setState(s: PlayerState): void {
    if (this._state === s) return;
    this._state = s;
    this.events.emit('state', s);
  }

  private async enterStageAt(position: number, epoch: number, autoplay = true): Promise<void> {
    const idx = this.stageIndexFor(position);
    const stage = this.pkg.audio.stages[idx]!;
    const offset = position - (this.starts[idx] ?? 0);
    this.destroyVoice();
    let el: MediaLike;
    if (this.next && this.next.index === idx) { el = this.next.el; this.next = null; }
    else el = this.createVoice(stage);
    this.stageIdx = idx;
    this.voice = el;
    el.currentTime = Math.max(0, Math.min(offset, Math.max(0, stage.duration - 0.05)));
    el.addEventListener('ended', this.onVoiceEnded);
    el.addEventListener('error', this.onVoiceError);
    this.events.emit('stage', { index: idx, stage });
    if (autoplay) {
      try { await el.play(); }
      catch (e) { if (epoch === this.epoch) this.events.emit('error', { message: `voice play() rejected for ${stage.name}`, cause: e }); }
    }
  }

  private createVoice(stage: StageTrack): MediaLike {
    const el = this.media.create(this.url(stage.file, stage.fileMp3));
    el.volume = this._voiceVolume;
    this.media.attach?.(el, 'voice');
    return el;
  }

  private maybePrebuffer(pos: number): void {
    const nextIdx = this.stageIdx + 1;
    if (nextIdx >= this.pkg.audio.stages.length) return;
    if (this.next?.index === nextIdx) return;
    const stageEnd = (this.starts[nextIdx] ?? this.duration);
    if (stageEnd - pos <= this.lead) {
      if (this.next) { this.next.el.src = ''; this.next.el.load(); }
      this.next = { index: nextIdx, el: this.createVoice(this.pkg.audio.stages[nextIdx]!) };
      this.next.el.load();
    }
  }

  private onVoiceEnded = (): void => {
    if (this._state !== 'playing') return;
    const nextIdx = this.stageIdx + 1;
    if (nextIdx >= this.pkg.audio.stages.length) {
      this.lastPosition = this.duration;
      this.destroyVoice();
      if (this.bed) { this.bed.pause(); }
      if (this._gate) this.closeGate('closed');
      this.setState('ended');
      this.events.emit('ended', undefined);
      return;
    }
    const epoch = ++this.epoch;
    void this.enterStageAt(this.starts[nextIdx] ?? 0, epoch);
  };

  private onVoiceError = (): void => {
    this.events.emit('error', { message: `voice audio failed to load: ${this.stage.name}` });
  };

  private destroyVoice(): void {
    const el = this.voice;
    if (!el) return;
    el.removeEventListener('ended', this.onVoiceEnded);
    el.removeEventListener('error', this.onVoiceError);
    el.pause();
    try { el.src = ''; el.load(); } catch { /* ok */ }
    this.voice = null;
  }

  private handleCue(ev: CueEvent): void {
    const c = ev.cue;
    if (c.type === 'gate') {
      if (ev.kind === 'enter') this.openGate(c);
      else if (this._gate?.cue === c) this.closeGate(this._gate.answered ? 'answered' : 'closed');
    } else if (c.type === 'intensity' && ev.kind === 'enter') {
      this.intensityTarget = Math.max(0, Math.min(1, c.value));
      const ramp = c.ramp ?? 0;
      if (ramp <= 0) { this._intensity = this.intensityTarget; this.intensityRate = 0; }
      else this.intensityRate = Math.abs(this.intensityTarget - this._intensity) / ramp || 1;
    }
    this.events.emit('cue', ev);
  }

  private openGate(cue: GateCue): void {
    if (this._gate) this.closeGate('closed');
    this._gate = { cue, deadline: cue.t + cue.window, answered: false };
    this.events.emit('gate', { gate: this._gate, phase: 'open' });
  }

  private closeGate(phase: 'answered' | 'closed'): void {
    const g = this._gate;
    if (!g) return;
    this._gate = null;
    this.events.emit('gate', { gate: g, phase });
  }

  dispose(): void {
    this.stop();
    if (this.next) { this.next.el.src = ''; this.next.el.load(); this.next = null; }
    this.events.clear();
  }
}

function canPlayOpusSafe(): boolean {
  try { return canPlayOpus(); } catch { return false; }
}

export type { Cue };
