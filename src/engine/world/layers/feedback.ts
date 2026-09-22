/**
 * FeedbackLayer — preset-side of the Milkdrop feedback warp.
 * The renderer owns the render targets; this layer only turns a single
 * `strength` value into warp parameters each frame.
 */

import { PropertyChannel } from '../channel';
import type { Layer, Preset, WorldInputs } from '../types';

export interface WarpParams {
  zoom: number;
  rotation: number;
  decay: number;
  blend: number;
  strength: number;
}

export class FeedbackLayer implements Layer {
  readonly name = 'feedback';
  private strength = new PropertyChannel(0.3, 2);
  readonly params: WarpParams = { zoom: 0.005, rotation: 0.0006, decay: 0.85, blend: 0.75, strength: 0.3 };

  applyPreset(preset: Preset, speed: number): void {
    if (preset.feedback?.strength !== undefined) this.strength.setTarget(preset.feedback.strength, speed);
  }

  update(_inputs: WorldInputs, dt: number): void {
    const s = this.strength.update(dt);
    this.params.strength = s;
    this.params.zoom = 0.004 + s * 0.006;
    this.params.rotation = 0.0005 + s * 0.001;
    this.params.decay = 0.78 + s * 0.12;
    this.params.blend = 0.85 - s * 0.25;
  }
}
