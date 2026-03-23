/**
 * BreathingGuide — intro, core, outro. Clean and simple.
 *
 * INTRO: "let's breathe together" text + clip
 * CORE:  N breath cycles, manually driving the breath controller each frame
 * OUTRO: "continue breathing" text + clip
 *
 * During CORE, the guide takes over the breath controller completely.
 * It computes the value from a local timer — no reliance on the
 * controller's internal clock.
 */

import type { BreathController } from './breath';
import type { Text3D } from './text3d';
import type { Presence } from './presence';

export interface BreathingGuideOptions {
  breaths: number;
  showText: boolean;
}

export class BreathingGuide {
  private text3d: Text3D;
  private breath: BreathController;
  private presence: Presence | null;
  private cancelled = false;
  private currentClip: HTMLAudioElement | null = null;

  constructor(text3d: Text3D, breath: BreathController, presence?: Presence) {
    this.text3d = text3d;
    this.breath = breath;
    this.presence = presence ?? null;
  }

  async run(opts: Partial<BreathingGuideOptions> = {}): Promise<void> {
    const breaths = opts.breaths ?? 4;
    const showText = opts.showText ?? true;
    this.cancelled = false;

    // ── CORE: manually drive N breath cycles ──
    const pat = this.breath.pattern;
    const cycleDuration = pat.inhale + (pat.holdIn ?? 0) + pat.exhale + (pat.holdOut ?? 0);

    // Bring wisp close
    if (this.presence) {
      const THREE = await import('three');
      this.presence.transitionTo('breathe', {
        size: 3.0,
        basePos: new THREE.Vector3(0, 0, -1.2),
        duration: 1.0,
      });
    }

    // Take over breath controller
    this.breath.forceValue(0);
    this.breath.forceStage('inhale');

    let lastLabel = '';
    const startTime = performance.now() / 1000;
    const totalDuration = cycleDuration * breaths;

    while (!this.cancelled) {
      const elapsed = performance.now() / 1000 - startTime;
      if (elapsed >= totalDuration) break;

      // Where are we in the current cycle?
      const cycleTime = elapsed % cycleDuration;

      let value: number;
      let label: string;

      if (cycleTime < pat.inhale) {
        // Inhale: 0 → 1
        const t = cycleTime / pat.inhale;
        value = (1 - Math.cos(t * Math.PI)) / 2; // smooth cosine
        label = 'in';
        this.breath.forceStage('inhale');
      } else if (cycleTime < pat.inhale + (pat.holdIn ?? 0)) {
        // Hold in: stay at 1
        value = 1;
        label = 'hold';
        this.breath.forceStage('hold-in');
      } else if (cycleTime < pat.inhale + (pat.holdIn ?? 0) + pat.exhale) {
        // Exhale: 1 → 0
        const t = (cycleTime - pat.inhale - (pat.holdIn ?? 0)) / pat.exhale;
        value = (1 + Math.cos(t * Math.PI)) / 2; // smooth cosine
        label = 'out';
        this.breath.forceStage('exhale');
      } else {
        // Hold out: stay at 0
        value = 0;
        label = 'hold';
        this.breath.forceStage('hold-out');
      }

      // Drive breath controller value
      this.breath.forceValue(value);

      // Play clip on label change
      if (label !== lastLabel) {
        lastLabel = label;
        if (label === 'in') this.playClip('breathe_in');
        else if (label === 'hold') this.playClip('breathe_hold');
        else if (label === 'out') this.playClip('breathe_out');

        if (showText) {
          this.text3d.showCue(label);
        }
      }

      // Drive text Z from value
      this.text3d.setSlotDepth(-1.2 + value * 0.7);

      await this.nextFrame();
    }

    // ── CLEANUP ──
    this.stopClip();
    this.breath.releaseForce();
    this.text3d.hideCue();
    this.text3d.clearSlotDepth();
    if (this.presence) this.presence.setSessionMode();
  }

  cancel(): void {
    this.cancelled = true;
  }

  private playClip(name: string): void {
    // Fade out previous clip instead of hard-cutting
    this.fadeOutClip();
    try {
      const audio = new Audio(`audio/shared/${name}.mp3`);
      audio.volume = 0.7;
      audio.play().catch(() => {});
      this.currentClip = audio;
    } catch { /* no audio */ }
  }

  private fadeOutClip(): void {
    const old = this.currentClip;
    if (!old) return;
    this.currentClip = null;
    // Quick fade over 300ms
    const startVol = old.volume;
    const fadeStart = performance.now();
    const fade = () => {
      const t = Math.min(1, (performance.now() - fadeStart) / 300);
      old.volume = startVol * (1 - t);
      if (t < 1) requestAnimationFrame(fade);
      else { old.pause(); }
    };
    requestAnimationFrame(fade);
  }

  private stopClip(): void {
    if (this.currentClip) {
      this.currentClip.pause();
      this.currentClip = null;
    }
  }

  private nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }
}
