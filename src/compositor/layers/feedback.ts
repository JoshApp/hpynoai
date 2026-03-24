/**
 * FeedbackLayer — Milkdrop-style frame accumulation warp.
 *
 * Wraps the existing FeedbackWarp class (complex adaptive quality logic).
 * Preset: { strength: 0-1 } — maps to zoom/rotation/decay params.
 */

import type * as THREE from 'three';
import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs, RenderContext } from '../types';
import { FeedbackWarp } from '../../feedback';

export class FeedbackLayer implements Layer {
  name = 'feedback';
  renderOrder = 100;    // after scene render, before overlay

  private feedback: FeedbackWarp;
  private strength = new PropertyChannel(0.5, 2);

  // Externally set composite quad for output
  private compositeQuad: THREE.Mesh;

  constructor(width: number, height: number, compositeQuad: THREE.Mesh) {
    this.feedback = new FeedbackWarp(width, height);
    this.compositeQuad = compositeQuad;
  }

  get tunnelTarget(): THREE.WebGLRenderTarget { return this.feedback.tunnelTarget; }
  get warp(): FeedbackWarp { return this.feedback; }

  resize(w: number, h: number): void { this.feedback.resize(w, h); }

  applyPreset(preset: Preset, speed: number): void {
    if (preset.feedback?.strength !== undefined) {
      this.strength.setTarget(preset.feedback.strength, speed);
    }
  }

  update(inputs: WorldInputs, dt: number): void {
    const s = this.strength.update(dt);
    this.feedback.setParams({
      zoom: 0.004 + s * 0.006,
      rotation: 0.0005 + s * 0.001,
    });
  }

  render(ctx: RenderContext): void {
    // Pass 1: scene already rendered to tunnelTarget by compositor
    // Pass 2: feedback composite
    const compositeTex = this.feedback.render(ctx.renderer, ctx.time, this.strength.current);
    (this.compositeQuad.material as THREE.MeshBasicMaterial).map = compositeTex;
  }

  dispose(): void {
    this.feedback.dispose();
  }
}
