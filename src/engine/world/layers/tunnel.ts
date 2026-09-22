/**
 * TunnelLayer — the hypnotic tunnel shader. Owns the material, the
 * fullscreen plane, and every uniform. Preset-driven via channels;
 * reactive inputs (audio, breath, voice, pointer) flow through WorldInputs.
 */

import * as THREE from 'three';
import { PropertyChannel, Vec3Channel } from '../channel';
import type { Layer, Preset, WorldInputs, BreathStage, Vec3 } from '../types';
import quadVert from '../../shaders/quad.vert';
import tunnelFrag from '../../shaders/tunnel.frag';

function stageToFloat(stage: BreathStage): number {
  switch (stage) {
    case 'inhale': return 0;
    case 'hold-in': return 1;
    case 'exhale': return 2;
    case 'hold-out': return 3;
  }
}

const tmpV2 = new THREE.Vector2();

export class TunnelLayer implements Layer {
  readonly name = 'tunnel';
  readonly material: THREE.ShaderMaterial;
  readonly mesh: THREE.Mesh;

  private readonly u = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uMouse: { value: new THREE.Vector2() },
    uBreathePhase: { value: 0 },
    uBreathValue: { value: 0 },
    uBreathStage: { value: 0 },
    uSpiralSpeed: { value: 1 },
    uSpiralAngle: { value: 0 },
    uScroll: { value: 0 },
    uTunnelWidth: { value: 1 },
    uBreathExpansion: { value: 1 },
    uTunnelShape: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uColor1: { value: new THREE.Vector3() },
    uColor2: { value: new THREE.Vector3() },
    uColor3: { value: new THREE.Vector3() },
    uColor4: { value: new THREE.Vector3() },
    uAudioEnergy: { value: 0 },
    uAudioBass: { value: 0 },
    uAudioMid: { value: 0 },
    uAudioHigh: { value: 0 },
    uVoiceEnergy: { value: 0 },
    uBreathSyncActive: { value: 0 },
    uBreathSyncFill: { value: 0 },
    uBreathSyncProgress: { value: 0 },
    uPresencePos: { value: new THREE.Vector3(0, 0, -1.5) },
    uPortalColor1: { value: new THREE.Vector3() },
    uPortalColor2: { value: new THREE.Vector3() },
    uPortalBlend: { value: 0 },
  };

  private intensity = new PropertyChannel(0.12, 2);
  private spiralSpeed = new PropertyChannel(0.5, 2);
  private audioReactivity = new PropertyChannel(0, 2);
  private shape = new PropertyChannel(0, 1);
  private speed = new PropertyChannel(1, 1.5);
  private width = new PropertyChannel(1, 1.5);
  private breathExpansion = new PropertyChannel(1, 1.5);
  private c1 = new Vec3Channel(0.3, 0.06, 0.14, 1.5);
  private c2 = new Vec3Channel(0.22, 0.05, 0.19, 1.5);
  private c3 = new Vec3Channel(0.78, 0.56, 0.5, 1.5);
  private c4 = new Vec3Channel(0.03, 0.016, 0.04, 1.5);
  private portalC1 = new Vec3Channel(0, 0, 0, 1.5);
  private portalC2 = new Vec3Channel(0, 0, 0, 1.5);
  private portalBlend = new PropertyChannel(0, 1.5);

  private spiralAngle = 0;
  private scroll = 0;

  constructor(scene: THREE.Scene) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: tunnelFrag,
      uniforms: this.u,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    scene.add(this.mesh);
  }

  setResolution(w: number, h: number): void {
    this.u.uResolution.value.set(w, h);
  }

  /** Wisp position — lights the tunnel wall at the wisp's depth. */
  setAnchorPosition(pos: THREE.Vector3): void {
    this.u.uPresencePos.value.copy(pos);
  }

  /** Portal preview (library card focus): show another palette beyond the wisp. */
  setPortal(c1: Vec3, c2: Vec3, blend: number): void {
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
    if (t.shape !== undefined) this.shape.setTarget(t.shape, speed);
    if (t.speed !== undefined) this.speed.setTarget(t.speed, speed);
    if (t.width !== undefined) this.width.setTarget(t.width, speed);
    if (t.breathExpansion !== undefined) this.breathExpansion.setTarget(t.breathExpansion, speed);
    if (t.colors) {
      this.c1.setTarget(...t.colors.c1, speed);
      this.c2.setTarget(...t.colors.c2, speed);
      this.c3.setTarget(...t.colors.c3, speed);
      this.c4.setTarget(...t.colors.c4, speed);
    }
  }

  update(inputs: WorldInputs, dt: number): void {
    const u = this.u;
    const intensity = this.intensity.update(dt);
    const spiral = this.spiralSpeed.update(dt);
    const reactivity = this.audioReactivity.update(dt);

    this.spiralAngle += dt * spiral * 0.5;
    this.scroll += dt * 0.6 * this.speed.update(dt);

    u.uTime.value = inputs.time;
    u.uIntensity.value = intensity;
    u.uMouse.value.lerp(tmpV2.set(inputs.pointer.x, inputs.pointer.y), 1 - Math.exp(-2 * dt));
    u.uBreathePhase.value = inputs.breath.phase;
    u.uBreathValue.value = inputs.breath.value;
    u.uBreathStage.value = stageToFloat(inputs.breath.stage);
    u.uSpiralSpeed.value = spiral;
    u.uSpiralAngle.value = this.spiralAngle;
    u.uScroll.value = this.scroll;
    u.uTunnelWidth.value = this.width.update(dt);
    u.uBreathExpansion.value = this.breathExpansion.update(dt);
    u.uTunnelShape.value = this.shape.update(dt);

    u.uColor1.value.set(...this.c1.update(dt));
    u.uColor2.value.set(...this.c2.update(dt));
    u.uColor3.value.set(...this.c3.update(dt));
    u.uColor4.value.set(...this.c4.update(dt));
    u.uPortalColor1.value.set(...this.portalC1.update(dt));
    u.uPortalColor2.value.set(...this.portalC2.update(dt));
    u.uPortalBlend.value = this.portalBlend.update(dt);

    const a = inputs.audio;
    u.uAudioEnergy.value = (a?.energy ?? 0) * reactivity;
    u.uAudioBass.value = (a?.bass ?? 0) * reactivity;
    u.uAudioMid.value = (a?.mid ?? 0) * reactivity;
    u.uAudioHigh.value = (a?.high ?? 0) * reactivity;
    u.uVoiceEnergy.value = inputs.voice;

    u.uBreathSyncActive.value = inputs.breathBand.active;
    u.uBreathSyncFill.value = inputs.breathBand.fill;
    u.uBreathSyncProgress.value = inputs.breathBand.progress;
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
