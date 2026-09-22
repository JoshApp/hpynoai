/**
 * WorldRenderer — owns the WebGL context and the four render passes:
 *   1. world scene → tunnelTarget
 *   2. feedback warp composite (ping-pong)
 *   3. blit composite to screen
 *   4. overlay scene (text, fade) drawn sharp on top, outside the warp
 * Also owns resize, pixel ratio, context-loss recovery.
 */

import * as THREE from 'three';
import { FeedbackWarp } from './feedback-warp';
import type { World } from '../world/world';
import { elog } from '../log';

export class WorldRenderer {
  readonly gl: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private warp: FeedbackWarp;
  private readonly compositeScene = new THREE.Scene();
  private readonly compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly compositeMat: THREE.MeshBasicMaterial;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private _contextLost = false;
  private needsClear = false;
  feedbackEnabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.gl.setClearColor(0x000000, 1);
    this.gl.autoClear = true;

    this.compositeMat = new THREE.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMat);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);

    this.warp = new FeedbackWarp(1, 1);

    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  get contextLost(): boolean { return this._contextLost; }

  private onLost = (e: Event): void => {
    e.preventDefault();
    this._contextLost = true;
    elog.warn('render', 'WebGL context lost');
  };

  private onRestored = (): void => {
    this._contextLost = false;
    this.warp.dispose();
    this.warp = new FeedbackWarp(this.width * this.pixelRatio, this.height * this.pixelRatio);
    this.needsClear = true;
    elog.info('render', 'WebGL context restored');
  };

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.pixelRatio = pixelRatio;
    this.gl.setPixelRatio(pixelRatio);
    this.gl.setSize(this.width, this.height, false);
    this.warp.resize(this.width * pixelRatio, this.height * pixelRatio);
    this.needsClear = true;
  }

  /** Hard cut: wipe the feedback trails on the next frame. */
  clearTrails(): void { this.needsClear = true; }

  render(world: World, time: number): void {
    if (this._contextLost) return;
    const gl = this.gl;
    if (this.needsClear) { this.warp.clear(gl); this.needsClear = false; }

    // Pass 1: world → tunnelTarget
    gl.setRenderTarget(this.warp.tunnelTarget);
    gl.render(world.scene, world.camera);
    gl.setRenderTarget(null);

    // Pass 2: feedback composite
    const tex = this.feedbackEnabled
      ? this.warp.render(gl, time, world.feedback.params)
      : this.warp.tunnelTarget.texture;

    // Pass 3: blit
    this.compositeMat.map = tex;
    gl.render(this.compositeScene, this.compositeCamera);

    // Pass 4: overlay, sharp
    gl.autoClear = false;
    gl.render(world.overlayScene, world.camera);
    gl.autoClear = true;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.warp.dispose();
    this.compositeMat.dispose();
    this.gl.dispose();
  }
}
