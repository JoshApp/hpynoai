/**
 * Milkdrop-style feedback warp system.
 *
 * Renders the tunnel to an offscreen texture, then warps the previous
 * accumulated frame toward the center with zoom + rotation, blending
 * the fresh render on top. Creates infinite depth trails.
 *
 * Uses two ping-pong render targets to avoid read-write conflicts.
 */

import * as THREE from 'three';
import feedbackVert from './shaders/feedback.vert';
import feedbackFrag from './shaders/feedback.frag';

export interface FeedbackParams {
  zoom: number;       // inward pull per frame (0.005-0.03)
  rotation: number;   // radians per frame (0.001-0.005)
  decay: number;      // old frame dimming (0.90-0.98)
  blend: number;      // fresh frame strength (0.3-0.7)
}

const DEFAULT_PARAMS: FeedbackParams = {
  zoom: 0.006,
  rotation: 0.0008,
  decay: 0.88,
  blend: 0.65,   // higher = fresh frame dominates, trails are subtle
};

export class FeedbackWarp {
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  /** Render target where the tunnel should be drawn (fresh frame) */
  readonly tunnelTarget: THREE.WebGLRenderTarget;
  private feedbackMaterial: THREE.ShaderMaterial;
  private feedbackMesh: THREE.Mesh;
  private feedbackScene: THREE.Scene;
  private feedbackCamera: THREE.OrthographicCamera;
  private flip = false;
  private params: FeedbackParams;

  constructor(width: number, height: number, params?: Partial<FeedbackParams>) {
    this.params = { ...DEFAULT_PARAMS, ...params };

    // Feedback runs at half resolution — the effect is soft by nature
    const hw = Math.ceil(width / 2);
    const hh = Math.ceil(height / 2);

    const rtOpts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    };

    this.rtA = new THREE.WebGLRenderTarget(hw, hh, rtOpts);
    this.rtB = new THREE.WebGLRenderTarget(hw, hh, rtOpts);
    this.tunnelTarget = new THREE.WebGLRenderTarget(width, height, rtOpts);

    this.feedbackMaterial = new THREE.ShaderMaterial({
      vertexShader: feedbackVert,
      fragmentShader: feedbackFrag,
      uniforms: {
        uPrevFrame: { value: this.rtA.texture },
        uFreshFrame: { value: this.tunnelTarget.texture },
        uZoom: { value: this.params.zoom },
        uRotation: { value: this.params.rotation },
        uDecay: { value: this.params.decay },
        uBlend: { value: this.params.blend },
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uResolution: { value: new THREE.Vector2(width, height) },
      },
    });

    this.feedbackMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.feedbackMaterial,
    );

    this.feedbackScene = new THREE.Scene();
    this.feedbackScene.add(this.feedbackMesh);

    this.feedbackCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Update params dynamically (e.g. tie zoom to intensity) */
  setParams(p: Partial<FeedbackParams>): void {
    Object.assign(this.params, p);
  }

  /** Call after rendering tunnel to tunnelTarget. Composites feedback. */
  render(renderer: THREE.WebGLRenderer, time: number, intensity: number): THREE.Texture {
    const u = this.feedbackMaterial.uniforms;
    const readRT = this.flip ? this.rtB : this.rtA;
    const writeRT = this.flip ? this.rtA : this.rtB;

    // Dynamic params — intensity drives how aggressive the warp is
    const intensityMod = 0.5 + intensity * 0.5;
    u.uPrevFrame.value = readRT.texture;
    u.uFreshFrame.value = this.tunnelTarget.texture;
    u.uZoom.value = this.params.zoom * intensityMod;
    u.uRotation.value = this.params.rotation * intensityMod;
    u.uDecay.value = this.params.decay;
    u.uBlend.value = this.params.blend;
    u.uTime.value = time;
    u.uIntensity.value = intensity;

    // Render feedback composite to writeRT
    renderer.setRenderTarget(writeRT);
    renderer.render(this.feedbackScene, this.feedbackCamera);
    renderer.setRenderTarget(null);

    this.flip = !this.flip;

    // Return the composited texture for final display
    return writeRT.texture;
  }

  resize(width: number, height: number): void {
    const hw = Math.ceil(width / 2);
    const hh = Math.ceil(height / 2);
    this.rtA.setSize(hw, hh);
    this.rtB.setSize(hw, hh);
    this.tunnelTarget.setSize(width, height);
    this.feedbackMaterial.uniforms.uResolution.value.set(hw, hh);
  }

  dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.tunnelTarget.dispose();
    this.feedbackMaterial.dispose();
    this.feedbackMesh.geometry.dispose();
  }
}
