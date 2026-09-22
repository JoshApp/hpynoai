/**
 * Wisp — the living focal point. A single additive-blended plane with the
 * presence shader, moved by composable "modes" (pure functions of time
 * and state). Transitions are dt-driven; nothing here uses timers.
 *
 * Modes:
 *   idle      gentle drift (library background)
 *   follow    tracks a target position (card focus)
 *   settle    drifts to center and calms (session start → auto 'breathe')
 *   breathe   locked to center, moves toward the viewer on inhale
 *   pendulum  slow lateral sway (deepening)
 *   speak     reacts to the narrator's voice
 *   hidden    faded out and not rendered
 */

import * as THREE from 'three';
import quadVert from '../shaders/quad.vert';
import presenceFrag from '../shaders/presence.frag';
import type { Vec3, WorldInputs } from './types';
import { wispColors } from './palette';

export type WispMode = 'idle' | 'follow' | 'settle' | 'breathe' | 'pendulum' | 'speak' | 'hidden';

interface ModeCtx {
  followTarget: THREE.Vector3;
  modeTime: number;
  breath: number;
  voice: number;
  intensity: number;
}

type ModeFn = (base: THREE.Vector3, time: number, ctx: ModeCtx, out: THREE.Vector3) => THREE.Vector3;

const modes: Record<WispMode, ModeFn> = {
  idle: (b, t, _c, o) => o.set(b.x + Math.sin(t * 0.15) * 0.02, b.y + Math.sin(t * 0.25) * 0.015, b.z),
  follow: (_b, _t, c, o) => o.copy(c.followTarget),
  settle: (b, t, c, o) => {
    const k = Math.min(1, c.modeTime / 3);
    const drift = 1 - k * k * (3 - 2 * k);
    return o.set(b.x + Math.sin(t * 0.2) * 0.01 * drift, b.y + Math.sin(t * 0.3) * 0.008 * drift, b.z);
  },
  breathe: (b, _t, c, o) => {
    const far = b.z, close = b.z + 0.45;
    return o.set(b.x, b.y + c.breath * 0.02, far + c.breath * (close - far));
  },
  pendulum: (b, t, c, o) => {
    const w = 0.15 + c.intensity * 0.1;
    return o.set(b.x + Math.sin(t * 0.4) * w, b.y + Math.sin(t * 0.28) * 0.02, b.z + Math.sin(t * 0.2) * 0.03);
  },
  speak: (b, _t, c, o) => o.set(b.x, b.y + c.voice * 0.01, b.z + c.voice * 0.1),
  hidden: (b, _t, _c, o) => o.copy(b),
};

interface Transition { fromSize: number; toSize: number; fromOpacity: number; toOpacity: number; duration: number; elapsed: number }

export interface WispTransitionOptions {
  size?: number;
  opacity?: number;
  duration?: number;
  basePos?: THREE.Vector3;
}

export class Wisp {
  readonly mesh: THREE.Mesh;
  private readonly u = {
    uTime: { value: 0 },
    uBreathValue: { value: 0 },
    uVoiceEnergy: { value: 0 },
    uAudioEnergy: { value: 0 },
    uAudioBass: { value: 0 },
    uIntensity: { value: 0.3 },
    uColor: { value: new THREE.Vector3(...wispColors.accent) },
    uCoreColor: { value: new THREE.Vector3(...wispColors.core) },
    uPulseColor: { value: new THREE.Vector3(...wispColors.accent) },
    uPulseAmount: { value: 0 },
    uRimWarp: { value: 0 },
  };

  private mode: WispMode = 'hidden';
  private modeTime = 0;
  private basePos = new THREE.Vector3(0, 0, -1.5);
  private followTarget = new THREE.Vector3(0, 0, -1.5);
  private target = new THREE.Vector3();
  private size = 0.8;
  private targetSize = 0.8;
  private opacity = 0;
  private targetOpacity = 0;
  private transition: Transition | null = null;
  private smoothVoice = 0;
  private smoothEnergy = 0;
  private smoothBass = 0;
  private accent: Vec3 = wispColors.accent;
  private pulseTimer = 0;
  private pulseRestore = 0;

  constructor(scene: THREE.Scene) {
    const material = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: presenceFrag,
      uniforms: this.u,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 100;
    this.mesh.frustumCulled = false;
    this.mesh.position.copy(this.basePos);
    scene.add(this.mesh);
  }

  get currentMode(): WispMode { return this.mode; }
  get position(): THREE.Vector3 { return this.mesh.position; }

  transitionTo(mode: WispMode, opts: WispTransitionOptions = {}): void {
    const toOpacity = mode === 'hidden' ? 0 : (opts.opacity ?? 1);
    this.transition = {
      fromSize: this.size,
      toSize: opts.size ?? this.targetSize,
      fromOpacity: this.opacity,
      toOpacity,
      duration: opts.duration ?? 1.5,
      elapsed: 0,
    };
    this.targetSize = opts.size ?? this.targetSize;
    if (this.pulseTimer > 0 && opts.size === undefined) this.targetSize = this.pulseRestore;
    this.targetOpacity = toOpacity;
    if (opts.basePos) this.basePos.copy(opts.basePos);
    if (mode !== this.mode) { this.mode = mode; this.modeTime = 0; }
    this.mesh.visible = true;
  }

  hide(duration = 1.5): void { this.transitionTo('hidden', { duration }); }

  /** Library: materialize from a spark. */
  enterIdle(): void {
    this.basePos.set(0, 0, -1.5);
    this.size = 0.05;
    this.mesh.scale.set(0.05, 0.05, 1);
    this.transitionTo('idle', { size: 0.9, opacity: 1, duration: 2 });
  }

  /** Session: settle to center, then auto-switch to breathe. */
  enterSession(): void {
    this.transitionTo('settle', { size: 0.7, basePos: new THREE.Vector3(0, 0.02, -1.3), duration: 3 });
  }

  followTo(x: number, y: number, z: number): void {
    this.followTarget.set(x, y + 0.02, z - 0.1);
    if (this.mode !== 'follow') this.transitionTo('follow', { duration: 0.5 });
  }

  setColors(accent: Vec3, core?: Vec3): void {
    this.accent = accent;
    this.u.uColor.value.set(...accent);
    const c = core ?? [Math.min(1, accent[0] * 1.4 + 0.1), Math.min(1, accent[1] * 1.4 + 0.1), Math.min(1, accent[2] * 1.3 + 0.1)];
    this.u.uCoreColor.value.set(c[0], c[1], c[2]);
  }

  /** Blend toward a color, then decay back. */
  colorPulse(color: Vec3, amount = 1): void {
    this.u.uPulseColor.value.set(...color);
    this.u.uPulseAmount.value = amount;
  }

  /** Expand briefly, then return (gate answered, card selected). */
  pulse(scale = 1.6): void {
    // Remember the resting size only when no pulse is in flight, so
    // overlapping pulses never compound.
    if (this.pulseTimer <= 0) this.pulseRestore = this.targetSize;
    this.pulseTimer = 0.4;
    this.transitionTo(this.mode, { size: this.pulseRestore * Math.min(scale, 1.8), duration: 0.4 });
  }

  update(inputs: WorldInputs, dt: number): void {
    this.modeTime += dt;

    if (this.pulseTimer > 0) {
      this.pulseTimer -= dt;
      if (this.pulseTimer <= 0) this.transitionTo(this.mode, { size: this.pulseRestore, duration: 0.8 });
    }

    const tr = this.transition;
    if (tr) {
      tr.elapsed += dt;
      const t = Math.min(1, tr.elapsed / tr.duration);
      const e = t * t * (3 - 2 * t);
      this.size = tr.fromSize + (tr.toSize - tr.fromSize) * e;
      this.opacity = tr.fromOpacity + (tr.toOpacity - tr.fromOpacity) * e;
      if (t >= 1) {
        this.transition = null;
        if (this.mode === 'settle') this.transitionTo('breathe', { duration: 2 });
        else if (this.mode === 'hidden') { this.mesh.visible = false; return; }
      }
    } else {
      const k = 1 - Math.exp(-2.4 * dt);
      this.size += (this.targetSize - this.size) * k;
      this.opacity += (this.targetOpacity - this.opacity) * k;
      if (this.opacity < 0.005 && this.targetOpacity === 0) { this.mesh.visible = false; return; }
    }

    const breath = inputs.breath.value;
    const ctx: ModeCtx = {
      followTarget: this.followTarget, modeTime: this.modeTime,
      breath, voice: this.smoothVoice, intensity: inputs.intensity,
    };
    modes[this.mode](this.basePos, inputs.time, ctx, this.target);
    const rate = this.mode === 'breathe' ? 9 : this.mode === 'follow' ? 3.6 : 1.8;
    this.mesh.position.lerp(this.target, 1 - Math.exp(-rate * dt));

    const voice = inputs.voice;
    const energy = inputs.audio?.energy ?? 0;
    const bass = inputs.audio?.bass ?? 0;
    this.smoothVoice += (voice - this.smoothVoice) * (1 - Math.exp(-(voice > this.smoothVoice ? 5 : 1.2) * dt));
    this.smoothEnergy += (energy - this.smoothEnergy) * (1 - Math.exp(-1.8 * dt));
    this.smoothBass += (bass - this.smoothBass) * (1 - Math.exp(-2.4 * dt));

    if (this.mode === 'breathe') {
      const a = this.accent;
      this.u.uColor.value.set(a[0] + breath * 0.15, a[1] + breath * 0.1, a[2] - breath * 0.05);
    }

    if (this.u.uPulseAmount.value > 0.005) this.u.uPulseAmount.value *= Math.exp(-2.4 * dt);

    const targetWarp = Math.min(1, this.smoothVoice * 1.5 + this.smoothBass * 0.3);
    const cur = this.u.uRimWarp.value;
    this.u.uRimWarp.value = cur + (targetWarp - cur) * (1 - Math.exp(-(targetWarp > cur ? 6 : 1.2) * dt));

    this.u.uTime.value = inputs.time;
    this.u.uBreathValue.value = breath;
    this.u.uVoiceEnergy.value = this.smoothVoice;
    this.u.uAudioEnergy.value = this.smoothEnergy;
    this.u.uAudioBass.value = this.smoothBass;
    this.u.uIntensity.value = (0.25 + inputs.intensity * 0.75) * this.opacity;

    const breathPulse = (this.mode === 'breathe' ? 0.08 : 0.03) * breath;
    const s = this.size + breathPulse + this.smoothVoice * 0.05;
    this.mesh.scale.set(s, s, 1);
  }

  dispose(): void {
    (this.mesh.material as THREE.ShaderMaterial).dispose();
    this.mesh.geometry.dispose();
  }
}
