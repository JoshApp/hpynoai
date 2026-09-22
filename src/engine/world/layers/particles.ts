/** ParticlesLayer — preset wrapper around the GPU particle cloud. */

import type * as THREE from 'three';
import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs } from '../types';
import { GpuParticles } from '../../render/gpu-particles';

export class ParticlesLayer implements Layer {
  readonly name = 'particles';
  readonly particles: GpuParticles;
  private intensity = new PropertyChannel(0, 2);
  private visible = false;
  private budget = 1;

  constructor(scene: THREE.Scene, count = 300) {
    this.particles = new GpuParticles(count);
    this.particles.mesh.visible = false;
    scene.add(this.particles.mesh);
  }

  /** Quality budget 0..1 (scales opacity/size cheaply instead of rebuilding buffers). */
  setBudget(b: number): void { this.budget = b; }

  applyPreset(preset: Preset, speed: number): void {
    const p = preset.particles;
    if (!p) return;
    if (p.intensity !== undefined) this.intensity.setTarget(p.intensity, speed);
    if (p.visible !== undefined) this.visible = p.visible;
    if (p.color) this.particles.setColor(...p.color);
  }

  update(inputs: WorldInputs, dt: number): void {
    const v = this.intensity.update(dt);
    const show = this.visible && this.budget > 0;
    this.particles.mesh.visible = show;
    if (show) this.particles.update(inputs.time, v, this.budget, 0.6 + this.budget * 0.4);
  }

  dispose(): void { this.particles.dispose(); }
}
