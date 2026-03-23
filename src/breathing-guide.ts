/**
 * BreathingGuide — voiced guided breathing using the wisp + tunnel + voice.
 *
 * Plays a pre-generated breathing voice guide, seeking to the right
 * phrase for each breath phase. The voice says "breathe in... hold...
 * breathe out..." timed to the actual breath controller.
 *
 * Falls back to text-only if no voice guide is available.
 */

import type { BreathController, BreathStage } from './breath';
import type { Text3D } from './text3d';

export interface BreathingGuideOptions {
  /** Number of complete breath cycles. Default: 4 */
  breaths: number;
  /** Show "in... / hold... / out..." text. Default: true */
  showText: boolean;
  /** Show breath count. Default: true */
  showCount: boolean;
}

const DEFAULTS: BreathingGuideOptions = {
  breaths: 4,
  showText: true,
  showCount: true,
};

interface SharedManifest {
  clips: Record<string, { file: string; duration: number }>;
  breathing: Record<string, {
    file: string;
    duration: number;
    words: Array<{ word: string; start: number; end: number }>;
    phases: Array<{ type: string; start: number; word?: string }>;
  }>;
}

export class BreathingGuide {
  private text3d: Text3D;
  private breath: BreathController;
  private cancelled = false;
  private lastStage: BreathStage = 'inhale';
  private completedBreaths = 0;
  private totalBreaths = 4;
  private audio: HTMLAudioElement | null = null;
  private manifest: SharedManifest | null = null;

  constructor(text3d: Text3D, breath: BreathController) {
    this.text3d = text3d;
    this.breath = breath;
  }

  /**
   * Run guided breathing. Plays voiced guide if available.
   */
  async run(options?: Partial<BreathingGuideOptions>, style: 'gentle' | 'commanding' = 'gentle'): Promise<void> {
    const opts = { ...DEFAULTS, ...options };
    this.cancelled = false;
    this.completedBreaths = 0;
    this.totalBreaths = opts.breaths;
    this.lastStage = 'exhale'; // so first inhale triggers

    // Try to load shared audio manifest
    try {
      const resp = await fetch('audio/shared/manifest.json');
      if (resp.ok) this.manifest = await resp.json();
    } catch { /* no manifest, text-only */ }

    // Start the voiced breathing guide if available
    const bgData = this.manifest?.breathing[style];
    if (bgData) {
      this.audio = new Audio(bgData.file);
      this.audio.volume = 0.8;
      await this.audio.play().catch(() => { this.audio = null; });
    }

    // Wait for a clean inhale start
    await this.waitForStage('inhale');
    if (this.cancelled) return this.cleanup();

    if (opts.showCount) this.showBreathCount();

    // Run breath cycles
    while (this.completedBreaths < this.totalBreaths && !this.cancelled) {
      const stage = this.breath.stage;

      // Show text on stage change
      if (opts.showText && stage !== this.lastStage) {
        // Detect cycle completion: transition back to inhale
        if (stage === 'inhale' && this.lastStage !== 'inhale') {
          this.completedBreaths++;
          if (this.completedBreaths >= this.totalBreaths) break;
          if (opts.showCount) this.showBreathCount();
        }

        this.lastStage = stage;
        this.showStageText(stage);
      }

      await this.nextFrame();
    }

    this.cleanup();
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.text3d.fadeOut();
  }

  get progress(): number {
    return this.completedBreaths / this.totalBreaths;
  }

  private showStageText(stage: BreathStage): void {
    // Always show text — reinforces the voice guide visually
    switch (stage) {
      case 'inhale':
        this.text3d.show('in . . .', 5);
        break;
      case 'hold-in':
        this.text3d.show('hold . . .', 5);
        break;
      case 'exhale':
        this.text3d.show('out . . .', 5);
        break;
      case 'hold-out':
        this.text3d.show('hold . . .', 5);
        break;
    }
  }

  private showBreathCount(): void {
    const remaining = this.totalBreaths - this.completedBreaths;
    if (remaining > 1) {
      this.text3d.show(`${remaining} breaths`, 6);
    } else if (remaining === 1) {
      this.text3d.show('last breath', 6);
    }
  }

  private waitForStage(target: BreathStage): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.cancelled) { resolve(); return; }
        if (this.breath.stage === target && this.breath.value < 0.1) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  }

  private nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }
}
