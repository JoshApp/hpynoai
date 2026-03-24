/**
 * FadeLayer — black overlay plane for transitions.
 *
 * Simplest layer: one PropertyChannel (opacity), one plane mesh.
 * Preset: { opacity: 0-1 }
 */

import * as THREE from 'three';
import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs, RenderContext } from '../types';

export class FadeLayer implements Layer {
  name = 'fade';
  renderOrder = 900;   // drawn last in overlay

  private opacity = new PropertyChannel(0, 4);
  private mesh: THREE.Mesh;

  constructor(overlayScene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(20, 20);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.z = 0.5;
    this.mesh.renderOrder = 9999;
    overlayScene.add(this.mesh);
  }

  applyPreset(preset: Preset, speed: number): void {
    if (preset.fade?.opacity !== undefined) {
      this.opacity.setTarget(preset.fade.opacity, speed);
    }
  }

  update(_inputs: WorldInputs, dt: number): void {
    const val = this.opacity.update(dt);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = val;
    this.mesh.visible = val > 0.001;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.MeshBasicMaterial).dispose();
  }
}
