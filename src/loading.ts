/**
 * Loading indicator — minimal, non-intrusive.
 * Shows a pulsing text sprite in the overlay scene during async operations.
 * Fades in/out smoothly. Multiple operations can overlap (refcounted).
 */

import * as THREE from 'three';
import { SpriteText } from './sprite-text';

export class LoadingIndicator {
  private sprite: THREE.Sprite;
  private scene: THREE.Scene;
  private refCount = 0;
  private targetOpacity = 0;
  private currentOpacity = 0;
  private visible = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.sprite = SpriteText.create('loading', {
      height: 0.04,
      fontSize: 24,
      color: '#887aaa',
      glow: 'rgba(136,122,170,0.2)',
    });
    this.sprite.position.set(0, -0.4, -1.5);
    this.sprite.visible = false;
    this.sprite.renderOrder = 500;
    SpriteText.setOpacity(this.sprite, 0);
    this.scene.add(this.sprite);
  }

  /** Start a loading operation. Returns a done() function. */
  start(label?: string): () => void {
    this.refCount++;
    if (label) {
      SpriteText.updateText(this.sprite, label);
    }
    this.targetOpacity = 1;
    if (!this.visible) {
      this.visible = true;
      this.sprite.visible = true;
    }

    let called = false;
    return () => {
      if (called) return;
      called = true;
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount === 0) {
        this.targetOpacity = 0;
      }
    };
  }

  /** Call every frame — handles fade and pulse */
  update(time: number): void {
    if (!this.visible && this.targetOpacity === 0) return;

    // Smooth fade
    this.currentOpacity += (this.targetOpacity - this.currentOpacity) * 0.05;

    if (this.currentOpacity < 0.01 && this.targetOpacity === 0) {
      this.sprite.visible = false;
      this.visible = false;
      this.currentOpacity = 0;
      return;
    }

    // Gentle pulse
    const pulse = 0.6 + Math.sin(time * 2) * 0.2;
    SpriteText.setOpacity(this.sprite, this.currentOpacity * pulse);
  }

  dispose(): void {
    this.scene.remove(this.sprite);
    SpriteText.dispose(this.sprite);
  }
}
