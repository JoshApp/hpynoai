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
import { log } from './logger';

export interface FeedbackParams {
  zoom: number;       // inward pull per frame (0.005-0.03)
  rotation: number;   // radians per frame (0.001-0.005)
  decay: number;      // old frame dimming (0.90-0.98)
  blend: number;      // fresh frame strength (0.3-0.7)
}

const DEFAULT_PARAMS: FeedbackParams = {
  zoom: 0.005,
  rotation: 0.0006,
  decay: 0.85,
  blend: 0.75,   // higher = fresh frame dominates, wall texture stays visible
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

  // Adaptive quality — auto-disable on low FPS
  private _disabled = false;
  private fpsHistory: number[] = [];
  private lastFrameTime = 0;
  private lowFpsFrames = 0;
  private highFpsFrames = 0;
  private static readonly LOW_FPS_THRESHOLD = 28;
  private static readonly HIGH_FPS_THRESHOLD = 45;
  private static readonly DISABLE_AFTER_FRAMES = 90;  // ~1.5s of low FPS
  private static readonly REENABLE_AFTER_FRAMES = 180; // ~3s of good FPS

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

  /** True if feedback was auto-disabled due to low FPS */
  get disabled(): boolean { return this._disabled; }

  /** Force enable/disable (overrides auto-detection) */
  set disabled(v: boolean) { this._disabled = v; }

  /** Call after rendering tunnel to tunnelTarget. Composites feedback.
   *  Returns the tunnel texture directly if feedback is disabled. */
  render(renderer: THREE.WebGLRenderer, time: number, intensity: number): THREE.Texture {
    // ── FPS monitoring ──
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      const fps = 1000 / (now - this.lastFrameTime);
      if (fps < FeedbackWarp.LOW_FPS_THRESHOLD) {
        this.lowFpsFrames++;
        this.highFpsFrames = 0;
      } else if (fps > FeedbackWarp.HIGH_FPS_THRESHOLD) {
        this.highFpsFrames++;
        this.lowFpsFrames = 0;
      } else {
        this.lowFpsFrames = Math.max(0, this.lowFpsFrames - 1);
        this.highFpsFrames = Math.max(0, this.highFpsFrames - 1);
      }

      if (!this._disabled && this.lowFpsFrames > FeedbackWarp.DISABLE_AFTER_FRAMES) {
        this._disabled = true;
        log.warn('feedback', 'Auto-disabled (low FPS)');
      } else if (this._disabled && this.highFpsFrames > FeedbackWarp.REENABLE_AFTER_FRAMES) {
        this._disabled = false;
        log.info('feedback', 'Re-enabled (FPS recovered)');
      }
    }
    this.lastFrameTime = now;

    // ── Skip feedback if disabled — return the raw tunnel render ──
    if (this._disabled) {
      return this.tunnelTarget.texture;
    }

    // ── Feedback composite ──
    const u = this.feedbackMaterial.uniforms;
    const readRT = this.flip ? this.rtB : this.rtA;
    const writeRT = this.flip ? this.rtA : this.rtB;

    const intensityMod = 0.5 + intensity * 0.5;
    u.uPrevFrame.value = readRT.texture;
    u.uFreshFrame.value = this.tunnelTarget.texture;
    u.uZoom.value = this.params.zoom * intensityMod;
    u.uRotation.value = this.params.rotation * intensityMod;
    u.uDecay.value = this.params.decay;
    u.uBlend.value = this.params.blend;
    u.uTime.value = time;
    u.uIntensity.value = intensity;

    renderer.setRenderTarget(writeRT);
    renderer.render(this.feedbackScene, this.feedbackCamera);
    renderer.setRenderTarget(null);

    this.flip = !this.flip;
    return writeRT.texture;
  }

  // ── Telemetry ──
  get isDisabled(): boolean { return this._disabled; }
  getLowFpsFrameCount(): number { return this.lowFpsFrames; }
  getParams(): FeedbackParams { return { ...this.params }; }

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
