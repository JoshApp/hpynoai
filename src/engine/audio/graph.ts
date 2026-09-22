/**
 * AudioGraph — the only Web Audio context in the app.
 *
 * Created lazily inside a user gesture. Media elements can be attached for
 * analysis (watch mode) — attaching routes the element through the graph,
 * so listen mode must NOT attach (elements play straight to the output
 * and survive screen lock on iOS).
 */

import { AudioAnalyzer } from './analyzer';
import { elog } from '../log';

export class AudioGraph {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _analyzer: AudioAnalyzer | null = null;
  private _voice: AudioAnalyzer | null = null;
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

  get context(): AudioContext | null { return this.ctx; }
  get ready(): boolean { return !!this.ctx && this.ctx.state === 'running'; }
  get analyzer(): AudioAnalyzer | null { return this._analyzer; }
  get voiceAnalyzer(): AudioAnalyzer | null { return this._voice; }

  /** Synchronous part of unlock: create the context and kick resume() without awaiting.
   *  Call this first thing inside a tap so Safari counts it as gesture-initiated. */
  unlockSync(): AudioContext {
    this.ensure();
    if (this.ctx!.state !== 'running') this.ctx!.resume().catch(() => {});
    return this.ctx!;
  }

  private ensure(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'playback' });
    this.master = this.ctx.createGain();
    this._analyzer = new AudioAnalyzer(this.ctx);
    this._voice = new AudioAnalyzer(this.ctx, 512);
    this._voice.setSmoothing(0.65);
    this.master.connect(this._analyzer.node);
    this._analyzer.node.connect(this.ctx.destination);
  }

  /** Create (if needed) and resume. Call from a user gesture. */
  async unlock(): Promise<AudioContext> {
    this.ensure();
    const ctx = this.ctx!;
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) { elog.warn('audio', 'resume failed', e); }
    }
    return ctx;
  }

  /** Route a media element through the graph. `role: 'voice'` also feeds the voice analyser. */
  attach(el: HTMLMediaElement, role: 'voice' | 'bed' = 'bed'): void {
    if (!this.ctx || !this.master) return;
    let src = this.sources.get(el);
    if (!src) {
      try { src = this.ctx.createMediaElementSource(el); }
      catch (e) { elog.warn('audio', 'createMediaElementSource failed', e); return; }
      this.sources.set(el, src);
    }
    src.disconnect();
    src.connect(this.master);
    if (role === 'voice' && this._voice) src.connect(this._voice.node);
  }

  setMasterGain(v: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  async suspend(): Promise<void> { await this.ctx?.suspend(); }
  async resume(): Promise<void> { if (this.ctx?.state === 'suspended') await this.ctx.resume(); }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null; this.master = null; this._analyzer = null; this._voice = null;
  }
}
