/**
 * TextActor — unified text display in the 3D scene.
 *
 * Wraps Text3D with the Actor interface. Receives directives
 * like { mode: 'cue', text: 'in' } and handles display internally.
 */

import type { Actor, ActorDirective, TextDirective, WorldInputs } from '../types';
import { Text3D, type TextStyle, type TextOptions } from '../../text3d';
import type * as THREE from 'three';

export class TextActor implements Actor {
  name = 'text';
  active = true;
  renderOrder = 200;

  private text3d: Text3D;
  private lastDirectiveKey = '';

  constructor(overlayScene: THREE.Scene) {
    this.text3d = new Text3D();
    overlayScene.add(this.text3d.mesh);
  }

  get display(): Text3D { return this.text3d; }

  setDirective(directive: ActorDirective): void {
    if (directive.type !== 'text') return;
    const d = directive.directive as TextDirective;
    this.applyTextDirective(d);
  }

  activate(directive?: ActorDirective): void {
    this.active = true;
    if (directive) this.setDirective(directive);
  }

  deactivate(): void {
    this.active = false;
    this.text3d.set(null);
    this.lastDirectiveKey = '';
  }

  private applyTextDirective(d: TextDirective): void {
    if (d.mode === 'clear') {
      this.text3d.set(null);
      this.lastDirectiveKey = '';
      return;
    }

    // Build a key to avoid re-applying the same directive
    const key = `${d.mode}:${d.text}`;
    if (key === this.lastDirectiveKey) {
      // Still update depth for breathing blocks (changes every frame)
      if (d.mode === 'cue' && d.depth !== undefined) {
        this.text3d.setSlotDepth(d.depth);
      }
      return;
    }
    this.lastDirectiveKey = key;

    switch (d.mode) {
      case 'cue':
        this.text3d.set(d.text, 'cue', { depth: d.depth });
        break;
      case 'prompt':
        this.text3d.set(d.text, 'prompt');
        break;
      case 'narration-tts':
        this.text3d.set(d.text, 'narration');
        break;
      case 'focus':
        this.text3d.set(d.text, 'focus', {
          words: d.words,
          audioRef: d.audioRef,
          audioLineStart: d.lineStart,
        });
        break;
    }
  }

  update(inputs: WorldInputs, dt: number): void {
    const intensity = inputs.timeline?.intensity ?? 0.12;
    this.text3d.update(intensity, inputs.breathPhase);
  }

  setColors(textColor: string, glowColor: string): void {
    this.text3d.setColors(textColor, glowColor);
  }

  setSettings(s: { startZ: number; endZ: number; scale: number }): void {
    this.text3d.setSettings(s);
  }
}
