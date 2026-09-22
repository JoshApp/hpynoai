/**
 * Milkdrop-style feedback warp. The fresh frame is rendered into
 * `tunnelTarget`; the previous accumulated frame is zoomed/rotated toward
 * the center, dimmed, and the fresh frame blended on top. Two half-res
 * ping-pong targets avoid read/write hazards.
 */

import * as THREE from 'three';
import quadVert from '../shaders/quad.vert';
import feedbackFrag from '../shaders/feedback.frag';
import type { WarpParams } from '../world/layers/feedback';

export class FeedbackWarp {
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  readonly tunnelTarget: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private flip = false;
  private readonly u = {
    uPrevFrame: { value: null as THREE.Texture | null },
    uFreshFrame: { value: null as THREE.Texture | null },
    uZoom: { value: 0.005 },
    uRotation: { value: 0.0006 },
    uDecay: { value: 0.85 },
    uBlend: { value: 0.75 },
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  };

  constructor(width: number, height: number) {
    const opts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false,
    };
    const hw = Math.max(1, Math.ceil(width / 2)), hh = Math.max(1, Math.ceil(height / 2));
    this.rtA = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.rtB = new THREE.WebGLRenderTarget(hw, hh, opts);
    this.tunnelTarget = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), opts);
    this.u.uPrevFrame.value = this.rtA.texture;
    this.u.uFreshFrame.value = this.tunnelTarget.texture;
    this.u.uResolution.value.set(hw, hh);
    this.material = new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: feedbackFrag, uniforms: this.u, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** Composite one frame. Returns the texture to blit to screen. */
  render(renderer: THREE.WebGLRenderer, time: number, p: WarpParams): THREE.Texture {
    const read = this.flip ? this.rtB : this.rtA;
    const write = this.flip ? this.rtA : this.rtB;
    const mod = 0.5 + p.strength * 0.5;
    this.u.uPrevFrame.value = read.texture;
    this.u.uFreshFrame.value = this.tunnelTarget.texture;
    this.u.uZoom.value = p.zoom * mod;
    this.u.uRotation.value = p.rotation * mod;
    this.u.uDecay.value = p.decay;
    this.u.uBlend.value = p.blend;
    this.u.uTime.value = time;
    this.u.uIntensity.value = p.strength;
    renderer.setRenderTarget(write);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(null);
    this.flip = !this.flip;
    return write.texture;
  }

  /** Clear the accumulation buffers (after context restore or a hard cut). */
  clear(renderer: THREE.WebGLRenderer): void {
    for (const rt of [this.rtA, this.rtB]) {
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(null);
  }

  resize(width: number, height: number): void {
    const hw = Math.max(1, Math.ceil(width / 2)), hh = Math.max(1, Math.ceil(height / 2));
    this.rtA.setSize(hw, hh);
    this.rtB.setSize(hw, hh);
    this.tunnelTarget.setSize(Math.max(1, width), Math.max(1, height));
    this.u.uResolution.value.set(hw, hh);
  }

  dispose(): void {
    this.rtA.dispose();
    this.rtB.dispose();
    this.tunnelTarget.dispose();
    this.material.dispose();
  }
}
