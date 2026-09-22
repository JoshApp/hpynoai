/**
 * World — the persistent 3D scene: tunnel, particles, wisp, overlay.
 * Framework-free. Driven by WorldInputs each frame and by presets.
 */

import * as THREE from 'three';
import { Compositor, type ConfigureOptions } from './compositor';
import { TunnelLayer } from './layers/tunnel';
import { FeedbackLayer } from './layers/feedback';
import { CameraLayer } from './layers/camera';
import { ParticlesLayer } from './layers/particles';
import { FadeLayer } from './layers/fade';
import { Wisp } from './wisp';
import { idlePreset } from './palette';
import type { Preset, WorldInputs } from './types';

export class World {
  readonly scene = new THREE.Scene();
  readonly overlayScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly compositor = new Compositor();
  readonly tunnel: TunnelLayer;
  readonly feedback: FeedbackLayer;
  readonly cameraLayer: CameraLayer;
  readonly particles: ParticlesLayer;
  readonly fade: FadeLayer;
  readonly wisp: Wisp;

  constructor(aspect = 1) {
    this.camera = new THREE.PerspectiveCamera(72, aspect, 0.1, 100);
    this.camera.position.z = 1.0;

    this.tunnel = new TunnelLayer(this.scene);
    this.feedback = new FeedbackLayer();
    this.cameraLayer = new CameraLayer(this.camera);
    this.particles = new ParticlesLayer(this.scene);
    this.fade = new FadeLayer(this.overlayScene);
    this.wisp = new Wisp(this.scene);

    for (const l of [this.tunnel, this.feedback, this.cameraLayer, this.particles, this.fade]) this.compositor.add(l);
    this.compositor.configure(idlePreset);
    this.compositor.snap();
  }

  get preset(): Preset { return this.compositor.preset; }

  configure(preset: Preset, opts?: ConfigureOptions): void {
    this.compositor.configure(preset, opts);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.tunnel.setResolution(width, height);
  }

  update(inputs: WorldInputs): void {
    this.compositor.update(inputs, inputs.dt);
    this.wisp.update(inputs, inputs.dt);
    this.tunnel.setAnchorPosition(this.wisp.position);
  }

  dispose(): void {
    this.compositor.dispose();
    this.wisp.dispose();
  }
}
