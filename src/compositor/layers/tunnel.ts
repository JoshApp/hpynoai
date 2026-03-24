/**
 * TunnelLayer — the hypnotic tunnel shader.
 *
 * Owns: shader material, plane mesh, all tunnel uniforms.
 * Preset: intensity, spiralSpeed, audioReactivity, colors, tunnelShape.
 * Reactive: audio bands, breath, voice, mouse — always running,
 * preset controls the strength.
 */

import * as THREE from 'three';
import { PropertyChannel, Vec3Channel } from '../channel';
import type { Layer, Preset, TunnelPreset, WorldInputs, RenderContext } from '../types';
import type { BreathStage } from '../../breath';
import type { SessionTheme } from '../../session';
import tunnelVert from '../../shaders/tunnel.vert';
import tunnelFrag from '../../shaders/tunnel.frag';

function breathStageToFloat(stage: BreathStage): number {
  switch (stage) {
    case 'inhale': return 0;
    case 'hold-in': return 1;
    case 'exhale': return 2;
    case 'hold-out': return 3;
  }
}

const _tmpVec2 = new THREE.Vector2();

export class TunnelLayer implements Layer {
  name = 'tunnel';
  renderOrder = 0;

  // Three.js objects
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, { value: unknown }>;

  // Channels driven by preset
  private intensity = new PropertyChannel(0.12, 2);
  private spiralSpeed = new PropertyChannel(0.5, 2);
  private audioReactivity = new PropertyChannel(0, 2);
  private tunnelShape = new PropertyChannel(0, 1);
  private c1 = new Vec3Channel(0.45, 0.1, 0.55, 1.5);
  private c2 = new Vec3Channel(0.7, 0.3, 0.9, 1.5);
  private c3 = new Vec3Channel(0.6, 0.3, 0.8, 1.5);
  private c4 = new Vec3Channel(0.15, 0.02, 0.25, 1.5);
  private portalC1 = new Vec3Channel(0.45, 0.1, 0.55, 1.5);
  private portalC2 = new Vec3Channel(0.7, 0.3, 0.9, 1.5);
  private portalBlend = new PropertyChannel(0, 1.5);

  // Runtime state (not preset-driven)
  private spiralAngle = 0;
  private mouseX = 0;
  private mouseY = 0;

  // Settings (from user preferences)
  private tunnelSpeed = 1;
  private tunnelWidth = 1;
  private breathExpansion = 1;
  private spiralSpeedMult = 1;

  constructor(scene: THREE.Scene) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: tunnelVert,
      fragmentShader: tunnelFrag,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uMouse: { value: new THREE.Vector2(0, 0) },
        uBreathePhase: { value: 0 },
        uBreathValue: { value: 0 },
        uBreathStage: { value: 0 },
        uSpiralSpeed: { value: 1.0 },
        uSpiralAngle: { value: 0 },
        uTunnelSpeed: { value: 1.0 },
        uTunnelWidth: { value: 1.0 },
        uBreathExpansion: { value: 1.0 },
        uTunnelShape: { value: 0.0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uColor1: { value: new THREE.Vector3(0.45, 0.1, 0.55) },
        uColor2: { value: new THREE.Vector3(0.7, 0.3, 0.9) },
        uColor3: { value: new THREE.Vector3(0.6, 0.3, 0.8) },
        uColor4: { value: new THREE.Vector3(0.15, 0.02, 0.25) },
        uAudioEnergy: { value: 0 },
        uAudioBass: { value: 0 },
        uAudioMid: { value: 0 },
        uAudioHigh: { value: 0 },
        uVoiceEnergy: { value: 0 },
        uBreathSyncActive: { value: 0 },
        uBreathSyncFill: { value: 0 },
        uBreathSyncProgress: { value: 0 },
        uPresencePos: { value: new THREE.Vector3(0, 0, -1.5) },
        uPortalColor1: { value: new THREE.Vector3(0.45, 0.1, 0.55) },
        uPortalColor2: { value: new THREE.Vector3(0.7, 0.3, 0.9) },
        uPortalBlend: { value: 0 },
      },
    });
    this.uniforms = this.material.uniforms;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.material);
    scene.add(this.mesh);
  }

  /** Apply user settings (from SettingsManager) */
  setSettings(s: {
    tunnelSpeed: number; tunnelWidth: number;
    breathExpansion: number; spiralSpeedMult: number;
  }): void {
    this.tunnelSpeed = s.tunnelSpeed;
    this.tunnelWidth = s.tunnelWidth;
    this.breathExpansion = s.breathExpansion;
    this.spiralSpeedMult = s.spiralSpeedMult;
  }

  setMouse(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
  }

  setResolution(w: number, h: number): void {
    (this.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  /** Set presence position (for wall illumination at wisp depth) */
  setPresencePos(pos: THREE.Vector3): void {
    (this.uniforms.uPresencePos.value as THREE.Vector3).copy(pos);
  }

  /** Apply session theme directly (instant, not animated) */
  applyTheme(theme: SessionTheme): void {
    this.c1.snap(...theme.primaryColor);
    this.c2.snap(...theme.secondaryColor);
    this.c3.snap(...theme.accentColor);
    this.c4.snap(...theme.bgColor);
    this.tunnelShape.snap(theme.tunnelShape ?? 0);
  }

  /** Set portal preview colors (selector hover) */
  setPortalColors(c1: [number, number, number], c2: [number, number, number], blend: number): void {
    this.portalC1.setTarget(...c1);
    this.portalC2.setTarget(...c2);
    this.portalBlend.setTarget(blend);
  }

  applyPreset(preset: Preset, speed: number): void {
    const t = preset.tunnel;
    if (!t) return;
    if (t.intensity !== undefined) this.intensity.setTarget(t.intensity, speed);
    if (t.spiralSpeed !== undefined) this.spiralSpeed.setTarget(t.spiralSpeed, speed);
    if (t.audioReactivity !== undefined) this.audioReactivity.setTarget(t.audioReactivity, speed);
    if (t.tunnelShape !== undefined) this.tunnelShape.setTarget(t.tunnelShape, speed);
    if (t.colors) {
      this.c1.setTarget(...t.colors.c1, speed);
      this.c2.setTarget(...t.colors.c2, speed);
      this.c3.setTarget(...t.colors.c3, speed);
      this.c4.setTarget(...t.colors.c4, speed);
    }
  }

  update(inputs: WorldInputs, dt: number): void {
    const u = this.uniforms;

    // Update channels
    const intensityVal = this.intensity.update(dt);
    const spiralSpd = this.spiralSpeed.update(dt);
    const reactivity = this.audioReactivity.update(dt);
    const shape = this.tunnelShape.update(dt);

    // Spiral angle accumulates (never eased — it's a rotation)
    this.spiralAngle += dt * spiralSpd * this.spiralSpeedMult * 0.5;

    // Apply to uniforms
    u.uTime.value = inputs.renderTime;
    u.uIntensity.value = intensityVal;
    (u.uMouse.value as THREE.Vector2).lerp(_tmpVec2.set(this.mouseX, this.mouseY), 0.02);
    u.uBreathePhase.value = inputs.breathPhase;
    u.uBreathValue.value = inputs.breathValue;
    u.uBreathStage.value = breathStageToFloat(inputs.breathStage);
    u.uSpiralSpeed.value = spiralSpd * this.spiralSpeedMult;
    u.uSpiralAngle.value = this.spiralAngle;
    u.uTunnelSpeed.value = this.tunnelSpeed;
    u.uTunnelWidth.value = this.tunnelWidth;
    u.uBreathExpansion.value = this.breathExpansion;
    u.uTunnelShape.value = shape;

    // Colors
    const [c1x, c1y, c1z] = this.c1.update(dt);
    const [c2x, c2y, c2z] = this.c2.update(dt);
    const [c3x, c3y, c3z] = this.c3.update(dt);
    const [c4x, c4y, c4z] = this.c4.update(dt);
    (u.uColor1.value as THREE.Vector3).set(c1x, c1y, c1z);
    (u.uColor2.value as THREE.Vector3).set(c2x, c2y, c2z);
    (u.uColor3.value as THREE.Vector3).set(c3x, c3y, c3z);
    (u.uColor4.value as THREE.Vector3).set(c4x, c4y, c4z);

    // Portal
    const [pc1x, pc1y, pc1z] = this.portalC1.update(dt);
    const [pc2x, pc2y, pc2z] = this.portalC2.update(dt);
    (u.uPortalColor1.value as THREE.Vector3).set(pc1x, pc1y, pc1z);
    (u.uPortalColor2.value as THREE.Vector3).set(pc2x, pc2y, pc2z);
    u.uPortalBlend.value = this.portalBlend.update(dt);

    // Audio — scaled by reactivity
    if (inputs.audioBands) {
      u.uAudioEnergy.value = inputs.audioBands.energy * reactivity;
      u.uAudioBass.value = inputs.audioBands.bass * reactivity;
      u.uAudioMid.value = inputs.audioBands.mid * reactivity;
      u.uAudioHigh.value = inputs.audioBands.high * reactivity;
    }
    u.uVoiceEnergy.value = inputs.voiceEnergy;

    // Interaction uniforms
    u.uBreathSyncActive.value = inputs.interactionShader.breathSyncActive;
    u.uBreathSyncFill.value = inputs.interactionShader.breathSyncFill;
    u.uBreathSyncProgress.value = inputs.interactionShader.breathSyncProgress;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
