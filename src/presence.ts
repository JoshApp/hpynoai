/**
 * Presence — a living energy entity that exists throughout HPYNO.
 *
 * Movement modes (transitions smoothly between them):
 *   idle      — gentle hover, barely moving (menu background)
 *   follow    — tracks a target position (carousel selection)
 *   settle    — drifts to center and calms down (session starting)
 *   breathe   — locked in place, pulses with breath (during session)
 *   pendulum  — slow side-to-side sway (deepening, future induction)
 *   speak     — reacts to voice energy (narrator active)
 *
 * All modes blend — the wisp smoothly transitions between behaviors.
 */

import * as THREE from 'three';
import presenceVert from './shaders/presence.vert';
import presenceFrag from './shaders/presence.frag';

export type PresenceMode = 'idle' | 'follow' | 'settle' | 'breathe' | 'pendulum' | 'speak';

export class Presence {
  readonly mesh: THREE.Mesh;
  private uniforms: Record<string, { value: unknown }>;
  private _visible = false;
  private targetOpacity = 0;
  private currentOpacity = 0;

  // Position/size targets (lerped smoothly)
  private targetPos = new THREE.Vector3(0, 0, -1.5);
  private basePos = new THREE.Vector3(0, 0, -1.5); // home position for current mode
  private targetSize = 0.8;
  private currentSize = 0.8;

  // Smoothed audio (prevents flicker — voice should feel like a glow, not a strobe)
  private smoothVoice = 0;
  private smoothEnergy = 0;
  private smoothBass = 0;

  // Movement mode
  private mode: PresenceMode = 'idle';
  private modeTime = 0; // time since mode changed

  // Follow target (for carousel)
  private followTarget = new THREE.Vector3(0, 0, -1.5);

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

    const geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 100;

    this.mesh.position.copy(this.targetPos);
    this.mesh.scale.set(this.targetSize, this.targetSize, 1);
  }

  // ── Mode setters ──

  show(): void {
    this._visible = true;
    this.mesh.visible = true;
    this.targetOpacity = 1;
  }

  hide(): void {
    this.targetOpacity = 0;
  }

  setMode(mode: PresenceMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.modeTime = 0;
  }

  /** Menu: materialize from nothing, then idle */
  setMenuMode(): void {
    this.basePos.set(0, 0, -1.5);
    this.currentSize = 0.05; // start tiny
    this.targetSize = 0.05;
    this.mesh.scale.set(0.05, 0.05, 1);
    this.setMode('idle');
    this.show();

    // Materialize: grow from spark to full size over 2 seconds
    const startTime = performance.now();
    const growTo = 3.5;
    const materialize = () => {
      const t = Math.min(1, (performance.now() - startTime) / 2000);
      // Ease out cubic — fast start, gentle settle
      const ease = 1 - (1 - t) * (1 - t) * (1 - t);
      this.targetSize = 0.05 + (growTo - 0.05) * ease;
      if (t < 1) requestAnimationFrame(materialize);
    };
    requestAnimationFrame(materialize);
  }

  /** Session: settle into tunnel, then breathe */
  setSessionMode(): void {
    this.basePos.set(0, 0.04, -2.0);
    this.targetSize = 2.0;
    this.setMode('settle');
    this.show();
    // After settling, switch to breathe mode
    setTimeout(() => {
      if (this.mode === 'settle') this.setMode('breathe');
    }, 3000);
  }

  /** Carousel: follow the focused orb */
  followTo(x: number, y: number, z: number): void {
    this.followTarget.set(x, y + 0.02, z - 0.1);
    if (this.mode !== 'follow') this.setMode('follow');
  }

  /** Pendulum mode: slow hypnotic sway */
  setPendulumMode(): void {
    this.setMode('pendulum');
  }

  /** Set colors from session theme */
  setColors(accent: [number, number, number]): void {
    (this.uniforms.uColor.value as THREE.Vector3).set(...accent);
    // Core color: brighter version of accent, still tinted (not white)
    (this.uniforms.uCoreColor.value as THREE.Vector3).set(
      Math.min(1, accent[0] * 1.4 + 0.1),
      Math.min(1, accent[1] * 1.4 + 0.1),
      Math.min(1, accent[2] * 1.3 + 0.1),
    );
  }

  setSize(s: number): void {
    this.targetSize = s;
  }

  // ── Update (call every frame) ──

  update(
    time: number,
    breathValue: number,
    voiceEnergy: number,
    audioEnergy: number,
    audioBass: number,
    intensity: number,
  ): void {
    this.modeTime += 1 / 60;

    // Fade opacity
    this.currentOpacity += (this.targetOpacity - this.currentOpacity) * 0.04;
    if (this.currentOpacity < 0.005 && this.targetOpacity === 0) {
      this.mesh.visible = false;
      this._visible = false;
      return;
    }

    // ── Compute target position based on mode ──
    switch (this.mode) {
      case 'idle':
        // Gentle figure-8 drift around base position
        this.targetPos.set(
          this.basePos.x + Math.sin(time * 0.15) * 0.02,
          this.basePos.y + Math.sin(time * 0.25) * 0.015,
          this.basePos.z,
        );
        break;

      case 'follow':
        // Track the follow target (carousel orb)
        this.targetPos.copy(this.followTarget);
        break;

      case 'settle':
        // Drift toward base position, gradually calming
        const settleProgress = Math.min(1, this.modeTime / 3);
        const settleEase = settleProgress * settleProgress * (3 - 2 * settleProgress);
        this.targetPos.set(
          this.basePos.x + Math.sin(time * 0.2) * 0.01 * (1 - settleEase),
          this.basePos.y + Math.sin(time * 0.3) * 0.008 * (1 - settleEase),
          this.basePos.z,
        );
        break;

      case 'breathe':
        // Locked in place, only breath moves it
        this.targetPos.copy(this.basePos);
        this.targetPos.z += breathValue * 0.04;
        this.targetPos.y += breathValue * 0.008;
        break;

      case 'pendulum':
        // Slow hypnotic side-to-side sway
        const swingSpeed = 0.4; // very slow
        const swingWidth = 0.15 + intensity * 0.1;
        this.targetPos.set(
          this.basePos.x + Math.sin(time * swingSpeed) * swingWidth,
          this.basePos.y + Math.sin(time * swingSpeed * 0.7) * 0.02,
          this.basePos.z + Math.sin(time * swingSpeed * 0.5) * 0.03,
        );
        break;

      case 'speak':
        // Mostly still, slight forward lean when voice active
        this.targetPos.copy(this.basePos);
        this.targetPos.z += voiceEnergy * 0.1;
        this.targetPos.y += voiceEnergy * 0.01;
        break;
    }

    // Smooth lerp to target
    const posLerp = this.mode === 'follow' ? 0.06 : 0.03;
    this.mesh.position.lerp(this.targetPos, posLerp);

    // Smooth size
    this.currentSize += (this.targetSize - this.currentSize) * 0.04;

    // Smooth audio values — voice should feel like a slow glow, not a strobe
    // Rise fast (0.08) so it responds, decay slow (0.02) so it lingers
    this.smoothVoice += (voiceEnergy - this.smoothVoice) * (voiceEnergy > this.smoothVoice ? 0.08 : 0.02);
    this.smoothEnergy += (audioEnergy - this.smoothEnergy) * 0.03;
    this.smoothBass += (audioBass - this.smoothBass) * 0.04;

    // Update uniforms with smoothed values
    this.uniforms.uTime.value = time;
    this.uniforms.uBreathValue.value = breathValue;
    this.uniforms.uVoiceEnergy.value = this.smoothVoice;
    this.uniforms.uAudioEnergy.value = this.smoothEnergy;
    this.uniforms.uAudioBass.value = this.smoothBass;
    this.uniforms.uIntensity.value = intensity * this.currentOpacity;

    // Scale: base + gentle breath + smoothed voice pulse
    const breathPulse = breathValue * 0.03;
    const voicePulse = this.smoothVoice * 0.05;
    const s = this.currentSize + breathPulse + voicePulse;
    this.mesh.scale.set(s, s, 1);
  }

  /** Lightweight update for menu (no audio/voice) */
  updateIdle(time: number, breathValue: number): void {
    this.update(time, breathValue, 0, 0, 0, 0.3);
  }

  get visible(): boolean {
    return this._visible;
  }

  get currentMode(): PresenceMode {
    return this.mode;
  }

  dispose(): void {
    (this.mesh.material as THREE.ShaderMaterial).dispose();
    this.mesh.geometry.dispose();
  }
}
