/**
 * CameraLayer — camera position, FOV, and sway.
 *
 * Preset: { sway: 0-1, fov: degrees }
 * Reactive: sway driven by intensity, gentle sin/cos movement
 */

import type * as THREE from 'three';
import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs, RenderContext } from '../types';

export class CameraLayer implements Layer {
  name = 'camera';
  renderOrder = 0;

  private camera: THREE.PerspectiveCamera;
  private sway = new PropertyChannel(0, 2);
  private fov = new PropertyChannel(75, 2);
  private cameraSway = 1;  // settings multiplier

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  setCameraSway(s: number): void { this.cameraSway = s; }

  applyPreset(preset: Preset, speed: number): void {
    if (preset.camera?.sway !== undefined) this.sway.setTarget(preset.camera.sway, speed);
    if (preset.camera?.fov !== undefined) this.fov.setTarget(preset.camera.fov, speed);
  }

  update(inputs: WorldInputs, dt: number): void {
    const swayAmount = this.sway.update(dt);
    const fovVal = this.fov.update(dt);

    // Gentle camera sway driven by render time
    const t = inputs.renderTime;
    this.camera.position.x = Math.sin(t * 0.1) * 0.02 * swayAmount * this.cameraSway;
    this.camera.position.y = Math.cos(t * 0.13) * 0.02 * swayAmount * this.cameraSway;

    if (Math.abs(this.camera.fov - fovVal) > 0.1) {
      this.camera.fov = fovVal;
      this.camera.updateProjectionMatrix();
    }
  }
}
