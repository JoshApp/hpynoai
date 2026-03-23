/**
 * Presence — a living energy entity that exists throughout HPYNO.
 *
 * Redesigned as a clean system with:
 *   - Event-driven transitions (no setTimeout / rAF inside)
 *   - Composable movement modes
 *   - Smooth blending between any two modes
 *   - Simple interface for other systems to drive
 *
 * Modes:
 *   idle      — gentle drift (menu background)
 *   follow    — tracks a world position (carousel)
 *   settle    — drifts to center, calms (session start)
 *   breathe   — locked, pulses with breath (during session)
 *   pendulum  — slow sway (deepening / induction)
 *   speak     — reacts to voice (narrator active)
 *   hidden    — faded out, not updating
 */

import * as THREE from 'three';
import presenceVert from './shaders/presence.vert';
import presenceFrag from './shaders/presence.frag';
import type { EventBus } from './events';

export type PresenceMode = 'idle' | 'follow' | 'settle' | 'breathe' | 'pendulum' | 'speak' | 'hidden';

export interface PresenceState {
  breathValue: number;
  voiceEnergy: number;
  audioEnergy: number;
  audioBass: number;
  intensity: number;
}

// ── Mode behaviors ─────────────────────────────────────────────
// Each returns a target position given the current state and time.
// Modes are pure functions — no side effects, easy to add new ones.

type ModeFn = (
  base: THREE.Vector3,
  time: number,
  state: PresenceState,
  ctx: { followTarget: THREE.Vector3; modeTime: number },
) => THREE.Vector3;

const tmp = new THREE.Vector3();

const modes: Record<string, ModeFn> = {
  idle: (base, time) => {
    return tmp.set(
      base.x + Math.sin(time * 0.15) * 0.02,
      base.y + Math.sin(time * 0.25) * 0.015,
      base.z,
    );
  },

  follow: (_base, _time, _state, ctx) => {
    return tmp.copy(ctx.followTarget);
  },

  settle: (base, time, _state, ctx) => {
    const t = Math.min(1, ctx.modeTime / 3);
    const ease = t * t * (3 - 2 * t);
    const drift = 1 - ease;
    return tmp.set(
      base.x + Math.sin(time * 0.2) * 0.01 * drift,
      base.y + Math.sin(time * 0.3) * 0.008 * drift,
      base.z,
    );
  },

  breathe: (base, _time, state) => {
    // Inhale (bv=1) → closer to user, exhale (bv=0) → further into tunnel
    const far = base.z;          // exhale position (base, e.g. -1.2)
    const close = base.z + 0.7;  // inhale position (e.g. -0.5)
    return tmp.set(
      base.x,
      base.y + state.breathValue * 0.02,
      far + state.breathValue * (close - far),
    );
  },

  pendulum: (base, time, state) => {
    const speed = 0.4;
    const width = 0.15 + state.intensity * 0.1;
    return tmp.set(
      base.x + Math.sin(time * speed) * width,
      base.y + Math.sin(time * speed * 0.7) * 0.02,
      base.z + Math.sin(time * speed * 0.5) * 0.03,
    );
  },

  speak: (base, _time, state) => {
    return tmp.set(
      base.x,
      base.y + state.voiceEnergy * 0.01,
      base.z + state.voiceEnergy * 0.1,
    );
  },

  hidden: (base) => tmp.copy(base),
};

// ── Transition ─────────────────────────────────────────────────
interface Transition {
  fromSize: number;
  toSize: number;
  fromOpacity: number;
  toOpacity: number;
  duration: number;  // seconds
  elapsed: number;
}

// ── Presence class ─────────────────────────────────────────────
export class Presence {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, { value: unknown }>;

  // State
  private mode: PresenceMode = 'hidden';
  private modeTime = 0;
  private basePos = new THREE.Vector3(0, 0, -1.5);
  private followTarget = new THREE.Vector3(0, 0, -1.5);
  private targetPos = new THREE.Vector3(0, 0, -1.5);

  // Size & opacity
  private size = 0.8;
  private targetSize = 0.8;
  private opacity = 0;
  private targetOpacity = 0;

  // Smooth audio (prevents flicker)
  private smoothVoice = 0;
  private smoothEnergy = 0;
  private smoothBass = 0;

  // Active transition (null = steady state)
  private transition: Transition | null = null;

  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      uBreathValue: { value: 0 },
      uVoiceEnergy: { value: 0 },
      uAudioEnergy: { value: 0 },
      uAudioBass: { value: 0 },
      uIntensity: { value: 0.3 },
      uColor: { value: new THREE.Vector3(0.6, 0.3, 0.9) },
      uCoreColor: { value: new THREE.Vector3(0.9, 0.8, 1.0) },
      uPulseColor: { value: new THREE.Vector3(0.6, 0.3, 0.9) },
      uPulseAmount: { value: 0 },
      uRimWarp: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: presenceVert,
      fragmentShader: presenceFrag,
      uniforms: this.uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 100;
    this.mesh.position.copy(this.basePos);
  }

  // ── Public API ───────────────────────────────────────────────

  /** Transition to a new mode with optional size/opacity targets */
  transitionTo(mode: PresenceMode, opts: {
    size?: number;
    opacity?: number;
    duration?: number;
    basePos?: THREE.Vector3;
  } = {}): void {
    const dur = opts.duration ?? 1.5;

    this.transition = {
      fromSize: this.size,
      toSize: opts.size ?? this.targetSize,
      fromOpacity: this.opacity,
      toOpacity: opts.opacity ?? (mode === 'hidden' ? 0 : 1),
      duration: dur,
      elapsed: 0,
    };

    this.targetSize = opts.size ?? this.targetSize;
    this.targetOpacity = mode === 'hidden' ? 0 : (opts.opacity ?? 1);

    if (opts.basePos) this.basePos.copy(opts.basePos);
    if (mode !== this.mode) {
      this.mode = mode;
      this.modeTime = 0;
    }

    this.mesh.visible = true;
  }

  /** Quick setters for common scenarios */
  show(): void {
    this.mesh.visible = true;
    this.targetOpacity = 1;
  }

  hide(duration = 1.5): void {
    this.transitionTo('hidden', { opacity: 0, duration });
  }

  /** Menu: materialize from a spark */
  setMenuMode(): void {
    this.basePos.set(0, 0, -1.5);
    this.size = 0.05;
    this.mesh.scale.set(0.05, 0.05, 1);
    this.transitionTo('idle', { size: 3.5, opacity: 1, duration: 2.0 });
  }

  /** Session: settle into tunnel center, then auto-switch to breathe */
  setSessionMode(): void {
    this.transitionTo('settle', {
      size: 2.0,
      basePos: new THREE.Vector3(0, 0.04, -2.0),
      duration: 3.0,
    });
  }

  /** Follow a position (e.g. carousel orb) */
  followTo(x: number, y: number, z: number): void {
    this.followTarget.set(x, y + 0.02, z - 0.1);
    if (this.mode !== 'follow') {
      this.transitionTo('follow', { duration: 0.5 });
    }
  }

  private baseAccent: [number, number, number] = [0.6, 0.3, 0.9];

  /** Set colors from session theme */
  setColors(accent: [number, number, number]): void {
    this.baseAccent = accent;
    (this.uniforms.uColor.value as THREE.Vector3).set(...accent);
    (this.uniforms.uCoreColor.value as THREE.Vector3).set(
      Math.min(1, accent[0] * 1.4 + 0.1),
      Math.min(1, accent[1] * 1.4 + 0.1),
      Math.min(1, accent[2] * 1.3 + 0.1),
    );
  }

  setMode(mode: PresenceMode): void {
    this.transitionTo(mode, { duration: 1.0 });
  }

  setSize(s: number): void {
    this.targetSize = s;
  }

  /** Color pulse — blend toward a target color then fade back. For breathing, emotions. */
  colorPulse(r: number, g: number, b: number, amount = 1.0): void {
    (this.uniforms.uPulseColor.value as THREE.Vector3).set(r, g, b);
    this.uniforms.uPulseAmount.value = amount;
  }

  /** Clear color pulse */
  clearPulse(): void {
    this.uniforms.uPulseAmount.value = 0;
  }

  /** Set rim warp directly (0 = calm circle, 1 = turbulent) */
  setRimWarp(amount: number): void {
    this.uniforms.uRimWarp.value = amount;
  }

  /** Quick size pulse — expands then returns. Used on session selection. */
  pulse(): void {
    const originalSize = this.targetSize;
    this.transitionTo(this.mode, {
      size: originalSize * 1.6,
      duration: 0.4,
    });
    // After expanding, shrink back
    setTimeout(() => {
      this.transitionTo(this.mode, {
        size: originalSize,
        duration: 0.8,
      });
    }, 400);
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  get currentMode(): PresenceMode {
    return this.mode;
  }

  // ── Bus-driven behavior ──────────────────────────────────────
  // Presence listens to lifecycle events and drives itself.
  // No external system needs to call setMenuMode/setSessionMode/etc.

  private busUnsubs: Array<() => void> = [];

  connectBus(bus: EventBus): void {
    // Clean previous
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];

    // Session starting → settle into tunnel
    this.busUnsubs.push(bus.on('session:starting', ({ session }) => {
      this.setColors(session.theme.accentColor);
      this.setSessionMode();
    }));

    // Session ended → hide
    this.busUnsubs.push(bus.on('session:ended', () => {
      this.hide();
    }));

    // Selector ready → menu mode
    this.busUnsubs.push(bus.on('selector:ready', () => {
      this.setMenuMode();
    }));

    // Theme preview (selector hovering sessions)
    this.busUnsubs.push(bus.on('settings:changed', () => {
      // No-op — presence doesn't need settings changes
    }));
  }

  disconnectBus(): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
  }

  // ── Update (call every frame) ────────────────────────────────

  update(
    time: number,
    breathValue: number,
    voiceEnergy: number,
    audioEnergy: number,
    audioBass: number,
    intensity: number,
  ): void {
    const dt = 1 / 60; // assume ~60fps, good enough for lerps
    this.modeTime += dt;

    // ── Process transition ──
    if (this.transition) {
      this.transition.elapsed += dt;
      const t = Math.min(1, this.transition.elapsed / this.transition.duration);
      const ease = t * t * (3 - 2 * t); // smoothstep

      this.size = this.transition.fromSize + (this.transition.toSize - this.transition.fromSize) * ease;
      this.opacity = this.transition.fromOpacity + (this.transition.toOpacity - this.transition.fromOpacity) * ease;

      if (t >= 1) {
        this.transition = null;
        // Auto-transitions
        if (this.mode === 'settle') {
          this.transitionTo('breathe', { duration: 2.0 });
        } else if (this.mode === 'hidden') {
          this.mesh.visible = false;
          return;
        }
      }
    } else {
      // Steady-state lerps
      this.size += (this.targetSize - this.size) * 0.04;
      this.opacity += (this.targetOpacity - this.opacity) * 0.04;
      if (this.opacity < 0.005 && this.targetOpacity === 0) {
        this.mesh.visible = false;
        return;
      }
    }

    // ── Compute position from mode ──
    const state: PresenceState = { breathValue, voiceEnergy, audioEnergy, audioBass, intensity };
    const ctx = { followTarget: this.followTarget, modeTime: this.modeTime };
    const modeFn = modes[this.mode] ?? modes.idle;
    const target = modeFn(this.basePos, time, state, ctx);
    this.targetPos.copy(target);

    // Smooth lerp to position — breathe mode tracks directly
    const posLerp = this.mode === 'breathe' ? 0.15 : this.mode === 'follow' ? 0.06 : 0.03;
    this.mesh.position.lerp(this.targetPos, posLerp);

    // ── Smooth audio (rise fast, decay slow) ──
    this.smoothVoice += (voiceEnergy - this.smoothVoice) * (voiceEnergy > this.smoothVoice ? 0.08 : 0.02);
    this.smoothEnergy += (audioEnergy - this.smoothEnergy) * 0.03;
    this.smoothBass += (audioBass - this.smoothBass) * 0.04;

    // ── Breath-state color tinting (in breathe mode) ──
    if (this.mode === 'breathe') {
      const a = this.baseAccent;
      // Inhale: warmer/brighter, Exhale: cooler/dimmer
      const warmth = breathValue; // 0 = exhaled, 1 = inhaled
      const colorVec = this.uniforms.uColor.value as THREE.Vector3;
      colorVec.set(
        a[0] + warmth * 0.15,
        a[1] + warmth * 0.1,
        a[2] - warmth * 0.05,
      );
    }

    // ── Decay color pulse ──
    const pulseVal = this.uniforms.uPulseAmount.value as number;
    if (pulseVal > 0.005) {
      this.uniforms.uPulseAmount.value = pulseVal * 0.96;
    }

    // ── Auto-drive rim warp from voice + audio energy ──
    // Voice makes outline turbulent, audio bass adds subtle movement
    const targetWarp = Math.min(1, this.smoothVoice * 1.5 + this.smoothBass * 0.3);
    const currentWarp = this.uniforms.uRimWarp.value as number;
    // Rise fast, decay slow — outline reacts immediately then calms gradually
    const warpLerp = targetWarp > currentWarp ? 0.1 : 0.02;
    this.uniforms.uRimWarp.value = currentWarp + (targetWarp - currentWarp) * warpLerp;

    // ── Uniforms ──
    this.uniforms.uTime.value = time;
    this.uniforms.uBreathValue.value = breathValue;
    this.uniforms.uVoiceEnergy.value = this.smoothVoice;
    this.uniforms.uAudioEnergy.value = this.smoothEnergy;
    this.uniforms.uAudioBass.value = this.smoothBass;
    this.uniforms.uIntensity.value = intensity * this.opacity;

    // ── Scale: breathes more noticeably in breathe mode ──
    const breathPulse = this.mode === 'breathe' ? breathValue * 0.08 : breathValue * 0.03;
    const voicePulse = this.smoothVoice * 0.05;
    const s = this.size + breathPulse + voicePulse;
    this.mesh.scale.set(s, s, 1);
  }

  /** Lightweight update for menu (no audio/voice) */
  updateIdle(time: number, breathValue: number): void {
    this.update(time, breathValue, 0, 0, 0, 0.3);
  }

  dispose(): void {
    (this.mesh.material as THREE.ShaderMaterial).dispose();
    this.mesh.geometry.dispose();
  }
}
