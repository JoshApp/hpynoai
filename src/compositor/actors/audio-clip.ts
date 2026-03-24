/**
 * AudioClipActor — manages breath/intro/outro audio clips.
 *
 * Compares desired clip (from directive) vs what's currently playing.
 * Crossfades between clips automatically.
 */

import type { Actor, ActorDirective, AudioClipDirective, WorldInputs } from '../types';

export class AudioClipActor implements Actor {
  name = 'audio-clip';
  active = true;
  renderOrder = 0;

  private currentClip: HTMLAudioElement | null = null;
  private currentName: string | null = null;
  private _volume = 0.7;

  setVolume(v: number): void {
    this._volume = v;
    if (this.currentClip) this.currentClip.volume = v;
  }

  setDirective(directive: ActorDirective): void {
    if (directive.type !== 'audio-clip') return;
    const d = directive.directive as AudioClipDirective;

    if (d.clip === this.currentName) return;

    if (d.clip) {
      this.play(d.clip);
    } else {
      this.stop();
    }
  }

  activate(directive?: ActorDirective): void {
    this.active = true;
    if (directive) this.setDirective(directive);
  }

  deactivate(): void {
    this.active = false;
    this.stop();
  }

  update(_inputs: WorldInputs, _dt: number): void {
    // Nothing per-frame — clips are fire-and-forget
  }

  private play(name: string): void {
    // Crossfade out old
    if (this.currentClip) {
      const old = this.currentClip;
      this.currentClip = null;
      const startVol = old.volume;
      const fadeStart = performance.now();
      const fade = () => {
        const t = Math.min(1, (performance.now() - fadeStart) / 300);
        old.volume = startVol * (1 - t);
        if (t < 1) requestAnimationFrame(fade);
        else old.pause();
      };
      requestAnimationFrame(fade);
    }

    try {
      const clip = new Audio(`audio/shared/${name}.mp3`);
      clip.volume = this._volume;
      clip.play().catch(() => {});
      this.currentClip = clip;
      this.currentName = name;
    } catch {
      this.currentName = null;
    }
  }

  private stop(): void {
    if (this.currentClip) {
      this.currentClip.pause();
      this.currentClip = null;
    }
    this.currentName = null;
  }

  get clipName(): string | null { return this.currentName; }
}
