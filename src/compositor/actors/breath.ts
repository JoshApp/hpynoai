/**
 * BreathActor — manages the BreathController.
 *
 * Receives directives to force-drive breath (breathing blocks)
 * or let it run freely (narration blocks).
 */

import type { Actor, ActorDirective, BreathDirective, WorldInputs } from '../types';
import type { BreathController } from '../../breath';

export class BreathActor implements Actor {
  name = 'breath';
  active = true;
  renderOrder = 0;

  private breath: BreathController;

  constructor(breath: BreathController) {
    this.breath = breath;
  }

  get controller(): BreathController { return this.breath; }

  setDirective(directive: ActorDirective): void {
    if (directive.type !== 'breath') return;
    const d = directive.directive as BreathDirective;

    switch (d.action) {
      case 'drive':
        this.breath.forceValue(d.value);
        this.breath.forceStage(d.stage);
        break;
      case 'apply-stage':
        this.breath.applyStage(d.stage);
        this.breath.releaseForce();
        break;
      case 'release':
        this.breath.releaseForce();
        break;
    }
  }

  activate(directive?: ActorDirective): void {
    this.active = true;
    if (directive) this.setDirective(directive);
  }

  deactivate(): void {
    this.active = false;
    this.breath.releaseForce();
  }

  update(inputs: WorldInputs, _dt: number): void {
    // Breath update is driven by the main loop's time
    // (needs performance.now for its own cycle)
    // This is intentionally lightweight — the real update
    // happens in main.ts since breath needs raw wall time
  }
}
