/** FadeLayer — black plane in the overlay scene for fades and "drop" triggers. */

import * as THREE from 'three';
import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs } from '../types';

export class FadeLayer implements Layer {
  readonly name = 'fade';
  private opacity = new PropertyChannel(0, 4);
  private flash = 0;
  private readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(overlayScene: THREE.Scene) {
    this.mat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), this.mat);
    this.mesh.position.z = 0.5;
    this.mesh.renderOrder = 9999;
    this.mesh.frustumCulled = false;
    overlayScene.add(this.mesh);
  }

  /** Instant hard cut to black (or white) that decays over `seconds`. */
  drop(seconds = 1.2, color: 'black' | 'white' = 'black'): void {
    this.mat.color.set(color === 'white' ? 0xffffff : 0x000000);
    this.flash = 1;
    this.flashDecay = 1 / Math.max(0.05, seconds);
  }
  private flashDecay = 1;

  applyPreset(preset: Preset, speed: number): void {
    if (preset.fade?.opacity !== undefined) this.opacity.setTarget(preset.fade.opacity, speed);
  }

  update(_inputs: WorldInputs, dt: number): void {
    const base = this.opacity.update(dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * this.flashDecay);
    const v = Math.max(base, this.flash * this.flash);
    this.mat.opacity = v;
    this.mesh.visible = v > 0.001;
    if (this.flash <= 0 && this.mat.color.getHex() !== 0x000000) this.mat.color.set(0x000000);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
