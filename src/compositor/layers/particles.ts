/**
 * ParticlesLayer — GPU-driven particle system.
 *
 * Currently disabled (mesh hidden). Layer exists so it can be
 * enabled via preset without code changes.
 */

import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs } from '../types';
import { GpuParticles } from '../../gpu-particles';
import type * as THREE from 'three';

export class ParticlesLayer implements Layer {
  name = 'particles';
  renderOrder = 10;

  private particles: GpuParticles;
  private intensity = new PropertyChannel(0, 2);
  private visible = false;

  constructor(scene: THREE.Scene, count = 250) {
    this.particles = new GpuParticles(count);
    scene.add(this.particles.mesh);
    this.particles.mesh.visible = false;
  }

  get gpu(): GpuParticles { return this.particles; }

  applyPreset(preset: Preset, speed: number): void {
    if (preset.particles?.intensity !== undefined) this.intensity.setTarget(preset.particles.intensity, speed);
    if (preset.particles?.visible !== undefined) this.visible = preset.particles.visible;
  }

  update(inputs: WorldInputs, dt: number): void {
    const val = this.intensity.update(dt);
    this.particles.mesh.visible = this.visible;
    if (this.visible) {
      this.particles.update(inputs.renderTime, val);
    }
  }

  setColor(r: number, g: number, b: number): void {
    this.particles.setColor(r, g, b);
  }

  dispose(): void {
    this.particles.mesh.geometry.dispose();
    (this.particles.mesh.material as THREE.ShaderMaterial).dispose();
  }
}
