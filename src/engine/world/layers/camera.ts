/** CameraLayer — gentle sway and eased FOV. */

import type * as THREE from 'three';
import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs } from '../types';

export class CameraLayer implements Layer {
  readonly name = 'camera';
  private sway = new PropertyChannel(0, 2);
  private fov = new PropertyChannel(72, 2);

  constructor(private camera: THREE.PerspectiveCamera) {}

  applyPreset(preset: Preset, speed: number): void {
    if (preset.camera?.sway !== undefined) this.sway.setTarget(preset.camera.sway, speed);
    if (preset.camera?.fov !== undefined) this.fov.setTarget(preset.camera.fov, speed);
  }

  update(inputs: WorldInputs, dt: number): void {
    const sway = this.sway.update(dt);
    const fov = this.fov.update(dt);
    const t = inputs.time;
    this.camera.position.x = Math.sin(t * 0.1) * 0.02 * sway;
    this.camera.position.y = Math.cos(t * 0.13) * 0.02 * sway;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
