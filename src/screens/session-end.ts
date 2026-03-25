/**
 * SessionEndScreen — graceful session completion.
 *
 * Sequence:
 *   1. "welcome back" (2s hold)
 *   2. Session name + duration summary (3s hold)
 *   3. Gentle fade → return to selector
 *
 * Musical: audio resolves to warm chord, closing tone plays,
 * reverb lingers as visual fades.
 */

import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import { playClosingTone, MENU_AUDIO_PRESET } from './audio-helpers';

export interface SessionSummary {
  sessionName: string;
  sessionIcon: string;
  durationSeconds: number;
  stagesCompleted: number;
  totalStages: number;
}

export class SessionEndScreen implements Screen {
  readonly name = 'session-end';
  private ctx: ScreenContext | null = null;
  private timers: number[] = [];
  private summary: SessionSummary;

  constructor(summary?: SessionSummary) {
    this.summary = summary ?? {
      sessionName: 'session',
      sessionIcon: '',
      durationSeconds: 0,
      stagesCompleted: 0,
      totalStages: 0,
    };
  }

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;
    ctx.hud.setMode('clean'); // no controls during end sequence

    // Musical resolution
    ctx.audioCompositor.resolve();
    playClosingTone(ctx.audio);

    // Presence settles — gentle, calm
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'idle' } });

    // Phase 1: "welcome back" (immediate)
    ctx.textActor.setDirective({
      type: 'text',
      directive: { mode: 'cue', text: 'welcome back' },
    });

    // Phase 2: Session summary (after 2.5s)
    this.timers.push(window.setTimeout(() => {
      if (!this.ctx) return;
      const mins = Math.floor(this.summary.durationSeconds / 60);
      const secs = Math.floor(this.summary.durationSeconds % 60);
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      const summaryText = this.summary.sessionIcon
        ? `${this.summary.sessionIcon} ${this.summary.sessionName}\n${timeStr}`
        : `${this.summary.sessionName}\n${timeStr}`;

      ctx.textActor.setDirective({
        type: 'text',
        directive: { mode: 'prompt', text: summaryText },
      });
    }, 2500));

    // Phase 3: Clear text before fade (after 5.5s)
    this.timers.push(window.setTimeout(() => {
      if (!this.ctx) return;
      ctx.textActor.setDirective({ type: 'text', directive: { mode: 'clear' } });
    }, 5500));

    // Phase 4: Navigate back to selector (after 6s)
    this.timers.push(window.setTimeout(async () => {
      if (!this.ctx) return;
      const { SessionSelectorScreen } = await import('./session-selector');
      ctx.screenManager.reset(new SessionSelectorScreen({ skipIntro: true }), {
        fadeOutMs: 2000, holdMs: 500, fadeInMs: 1500,
      });
    }, 6000));
  }

  exit(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.ctx) {
      this.ctx.textActor.setDirective({ type: 'text', directive: { mode: 'clear' } });
    }
    this.ctx = null;
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    // Keep the visual world alive — gentle breathing, slow spiral
    const ctx = this.ctx;
    ctx.breath.update(time);
    // Presence driven by PresenceActor via compositor
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }
}
