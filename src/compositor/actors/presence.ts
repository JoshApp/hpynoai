/**
 * PresenceActor — wraps the Presence class as a compositor actor.
 *
 * Receives role directives ('menu-guide', 'breathing-companion', 'narrator',
 * 'idle', 'hidden') and translates them into Presence method calls.
 * The compositor calls update() each frame — no manual wiring needed per screen.
 *
 * Screens just set a directive and the wisp figures out the rest.
 */

import * as THREE from 'three';
import type { Actor, ActorDirective, PresenceDirective, WorldInputs } from '../types';
import type { Presence } from '../../presence';
import type { TunnelLayer } from '../layers/tunnel';

export class PresenceActor implements Actor {
  name = 'presence';
  active = true;
  renderOrder = 50;

  private presence: Presence;
  private tunnelLayer: TunnelLayer;
  private currentRole: PresenceDirective['role'] | null = null; // null = never set
  private followTarget: { x: number; y: number; z: number } | null = null;

  constructor(presence: Presence, tunnelLayer: TunnelLayer) {
    this.presence = presence;
    this.tunnelLayer = tunnelLayer;
  }

  get entity(): Presence { return this.presence; }

  setDirective(directive: ActorDirective): void {
    if (directive.type !== 'presence') return;
    const d = directive.directive as PresenceDirective;

    if (d.role === this.currentRole) return;
    this.currentRole = d.role;

    switch (d.role) {
      case 'menu-guide':
        this.presence.setMenuMode();
        break;
      case 'breathing-companion':
        this.presence.transitionTo('breathe', {
          size: 3.0,
          basePos: new THREE.Vector3(0, 0, -1.2),
          duration: 1.0,
        });
        break;
      case 'narrator':
        this.presence.setSessionMode();
        break;
      case 'idle':
        this.presence.transitionTo('idle', {
          size: 3.5,
          basePos: new THREE.Vector3(0, 0.04, -1.3),
          duration: 2.0,
        });
        break;
      case 'hidden':
        this.presence.hide();
        break;
    }
  }

  activate(directive?: ActorDirective): void {
    this.active = true;
    this.presence.show();
    if (directive) this.setDirective(directive);
  }

  deactivate(): void {
    this.active = false;
    this.presence.hide();
  }

  /** Follow a position (for carousel orb tracking) */
  follow(x: number, y: number, z: number): void {
    this.presence.followTo(x, y, z);
    this.currentRole = 'menu-guide'; // follow is a sub-behavior of menu-guide
  }

  /** Visual pulse (orb selected) */
  pulse(): void {
    this.presence.pulse();
  }

  /** Set accent colors */
  setColors(accent: [number, number, number]): void {
    this.presence.setColors(accent);
  }

  update(inputs: WorldInputs, _dt: number): void {
    if (this.currentRole === null) return; // never activated
    const t = inputs.renderTime;
    const bv = inputs.breathValue;

    if (this.currentRole === 'menu-guide' || this.currentRole === 'idle') {
      // Menu: lightweight update, no audio
      this.presence.updateIdle(t, bv);
    } else {
      // Session: full update with audio reactivity
      this.presence.update(
        t, bv,
        inputs.voiceEnergy,
        inputs.audioBands?.energy ?? 0,
        inputs.audioBands?.bass ?? 0,
        inputs.timeline?.intensity ?? 0.3,
      );
    }

    // Sync position to tunnel shader (wall illumination at wisp depth)
    this.tunnelLayer.setPresencePos(this.presence.mesh.position);
  }

  onSessionStart?(session: import('../../session').SessionConfig): void {
    this.presence.setColors(session.theme.accentColor);
  }

  onSessionEnd?(): void {
    this.currentRole = 'idle';
  }

  dispose(): void {
    // Presence disposal handled by main.ts onTeardown
  }
}
