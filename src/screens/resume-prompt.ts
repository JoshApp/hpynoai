/**
 * ResumePromptScreen — immersive 3D prompt to resume a saved session.
 *
 * Shows session name + saved position with "continue" / "start fresh" options.
 * Wisp pulses gently, tunnel at low intensity. Feels like waking up.
 */

import type { Screen, ScreenContext } from '../screen';
import type { AudioPreset } from '../audio-compositor';
import type { SavedSession } from '../session-persistence';
import { clearProgress, formatTime } from '../session-persistence';
import { sessions } from '../sessions/index';
import { MENU_AUDIO_PRESET } from './audio-helpers';
import { log } from '../logger';

export class ResumePromptScreen implements Screen {
  readonly name = 'resume-prompt';

  private ctx: ScreenContext | null = null;
  private saved: SavedSession;
  private unsubs: Array<() => void> = [];
  private timeoutTimer: number | null = null;

  constructor(saved: SavedSession) {
    this.saved = saved;
  }

  enter(ctx: ScreenContext, _from: string | null): void {
    this.ctx = ctx;

    const session = sessions.find(s => s.id === this.saved.sessionId);
    const sessionName = session?.name ?? this.saved.sessionId;
    const icon = session?.icon ?? '';
    const timeStr = formatTime(this.saved.position);

    // Show resume text
    ctx.textActor.setDirective({
      type: 'text',
      directive: {
        mode: 'prompt',
        text: `${icon} ${sessionName}\nresume at ${timeStr}?`,
      },
    });

    // Wisp gently pulses
    ctx.presenceActor.setDirective({ type: 'presence', directive: { role: 'idle' } });

    // Confirm = resume session
    this.unsubs.push(ctx.bus.on('input:confirm', async () => {
      if (!this.ctx || !session) return;
      log.info('resume', `Resuming ${sessionName} at ${timeStr}`);
      const { SessionScreen } = await import('./session');
      ctx.screenManager.replace(
        new SessionScreen(session, { resumePosition: this.saved.position }),
        { fadeOutMs: 1000, holdMs: 300, fadeInMs: 800 },
      );
    }));

    // Back = start fresh
    this.unsubs.push(ctx.bus.on('input:back', async () => {
      clearProgress();
      log.info('resume', 'User chose to start fresh');
      const { SessionSelectorScreen } = await import('./session-selector');
      ctx.screenManager.replace(new SessionSelectorScreen(), { fadeOutMs: 800, holdMs: 200, fadeInMs: 600 });
    }));

    // Auto-dismiss after 10 seconds → go to selector
    this.timeoutTimer = window.setTimeout(async () => {
      if (!this.ctx) return;
      const { SessionSelectorScreen } = await import('./session-selector');
      ctx.screenManager.replace(new SessionSelectorScreen());
    }, 10000);
  }

  exit(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.ctx) {
      this.ctx.textActor.setDirective({ type: 'text', directive: { mode: 'clear' } });
    }
    this.ctx = null;
  }

  render(time: number, _dt: number): void {
    if (!this.ctx) return;
    this.ctx.breath.update(time);
  }

  getAudioPreset(): Partial<AudioPreset> {
    return MENU_AUDIO_PRESET;
  }
}
