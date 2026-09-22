/** Hand-off of a SessionDirector started inside a tap on the detail sheet to the player screen. */
import type { SessionDirector } from './session-director';

class SessionHandoff {
  pending = $state<SessionDirector | null>(null);
  take(id: string): SessionDirector | null {
    const d = this.pending;
    if (d && d.player.pkg.id === id) { this.pending = null; return d; }
    if (d) { d.dispose(); this.pending = null; }
    return null;
  }
}
export const handoff = new SessionHandoff();
