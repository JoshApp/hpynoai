/**
 * Guided calibration — 3-step in-tunnel wizard.
 * Runs inside the 3D scene using floating text sprites.
 * Arrow keys to adjust, Space to confirm each step.
 */

import * as THREE from 'three';
import type { SettingsManager } from './settings';
import type { AudioEngine } from './audio';
import type { Text3D } from './text3d';

interface CalibrationDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  settings: SettingsManager;
  audio: AudioEngine;
  text3d: Text3D;
}

export class GuidedCalibration {
  private deps: CalibrationDeps;
  private group: THREE.Group;
  private sprites: THREE.Sprite[] = [];
  private _active = false;
  private cancelled = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private testOsc: OscillatorNode | null = null;
  private testGain: GainNode | null = null;
  private testCtx: AudioContext | null = null;

  constructor(deps: CalibrationDeps) {
    this.deps = deps;
    this.group = new THREE.Group();
    this.deps.scene.add(this.group);
  }

  get isActive(): boolean {
    return this._active;
  }

  async run(): Promise<void> {
    this._active = true;
    this.cancelled = false;

    try {
      await this.sleep(500);
      if (this.cancelled) return;

      await this.runStepSpeed();
      if (this.cancelled) return;

      await this.runStepText();
      if (this.cancelled) return;

      await this.runStepAudio();
      if (this.cancelled) return;

      // Done
      await this.showMessage('calibration complete', 2000);
    } finally {
      this.cleanup();
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.stopTestTone();
    this.cleanup();
  }

  update(_time: number): void {
    // Gentle bob on all active sprites
    if (!this._active) return;
    const t = performance.now() / 1000;
    for (const sprite of this.sprites) {
      if (!sprite.visible) continue;
      sprite.position.y += Math.sin(t * 2) * 0.0002;
    }
  }

  // ── Steps ──

  private async runStepSpeed(): Promise<void> {
    const title = this.addSprite('tunnel speed', 48, '#c8a0ff', 0, 0.25, -2);
    const hint = this.addSprite(
      '\u2190 slower   \u2192 faster   space = confirm',
      28, '#8060aa', 0, -0.05, -1.8,
    );
    const valueSprite = this.addSprite('', 32, '#a8e6cf', 0, 0.08, -1.8);

    await this.animateIn(title, 1000);
    await this.animateIn(hint, 800);
    await this.animateIn(valueSprite, 500);
    if (this.cancelled) return;

    let speed = this.deps.settings.current.tunnelSpeed;
    this.updateSpriteText(valueSprite, this.fmtVal(speed, 'x'));

    await this.waitForAdjustment({
      onLeft: () => {
        speed = Math.max(0, speed - 0.1);
        this.deps.settings.updateBatch({ tunnelSpeed: speed });
        this.updateSpriteText(valueSprite, this.fmtVal(speed, 'x'));
      },
      onRight: () => {
        speed = Math.min(5, speed + 0.1);
        this.deps.settings.updateBatch({ tunnelSpeed: speed });
        this.updateSpriteText(valueSprite, this.fmtVal(speed, 'x'));
      },
    });

    this.animateOut(title, 600);
    this.animateOut(hint, 600);
    this.animateOut(valueSprite, 600);
    await this.sleep(700);
  }

  private async runStepText(): Promise<void> {
    // Show sample narration text
    this.deps.text3d.show('you are feeling calm and focused', 30);

    const title = this.addSprite('text readability', 48, '#c8a0ff', 0, 0.25, -2);
    const hint = this.addSprite(
      '\u2190 smaller   \u2192 bigger   space = confirm',
      28, '#8060aa', 0, -0.05, -1.8,
    );
    const valueSprite = this.addSprite('', 32, '#a8e6cf', 0, 0.08, -1.8);

    await this.animateIn(title, 1000);
    await this.animateIn(hint, 800);
    await this.animateIn(valueSprite, 500);
    if (this.cancelled) return;

    let scale = this.deps.settings.current.narrationScale;
    this.updateSpriteText(valueSprite, this.fmtVal(scale, 'x'));

    await this.waitForAdjustment({
      onLeft: () => {
        scale = Math.max(0.1, scale - 0.1);
        this.deps.settings.updateBatch({ narrationScale: scale });
        this.updateSpriteText(valueSprite, this.fmtVal(scale, 'x'));
      },
      onRight: () => {
        scale = Math.min(5, scale + 0.1);
        this.deps.settings.updateBatch({ narrationScale: scale });
        this.updateSpriteText(valueSprite, this.fmtVal(scale, 'x'));
      },
    });

    this.deps.text3d.clear();
    this.animateOut(title, 600);
    this.animateOut(hint, 600);
    this.animateOut(valueSprite, 600);
    await this.sleep(700);
  }

  private async runStepAudio(): Promise<void> {
    this.startTestTone();

    const title = this.addSprite('audio level', 48, '#c8a0ff', 0, 0.25, -2);
    const hint = this.addSprite(
      '\u2190 quieter   \u2192 louder   space = confirm',
      28, '#8060aa', 0, -0.05, -1.8,
    );
    const valueSprite = this.addSprite('', 32, '#a8e6cf', 0, 0.08, -1.8);

    await this.animateIn(title, 1000);
    await this.animateIn(hint, 800);
    await this.animateIn(valueSprite, 500);
    if (this.cancelled) return;

    let vol = this.deps.settings.current.masterVolume;
    this.updateSpriteText(valueSprite, Math.round(vol * 100) + '%');

    await this.waitForAdjustment({
      onLeft: () => {
        vol = Math.max(0, vol - 0.05);
        this.deps.settings.updateBatch({ masterVolume: vol });
        this.setTestToneVolume(vol);
        this.updateSpriteText(valueSprite, Math.round(vol * 100) + '%');
      },
      onRight: () => {
        vol = Math.min(2, vol + 0.05);
        this.deps.settings.updateBatch({ masterVolume: vol });
        this.setTestToneVolume(vol);
        this.updateSpriteText(valueSprite, Math.round(vol * 100) + '%');
      },
    });

    this.stopTestTone();
    this.animateOut(title, 600);
    this.animateOut(hint, 600);
    this.animateOut(valueSprite, 600);
    await this.sleep(700);
  }

  // ── Test tone ──

  private startTestTone(): void {
    // Use the audio engine's context if available, otherwise create our own
    const ctx = this.deps.audio.context ?? new AudioContext();
    this.testCtx = this.deps.audio.context ? null : ctx; // track if we own it

    this.testGain = ctx.createGain();
    this.testGain.gain.value = 0;
    this.testGain.connect(ctx.destination);

    this.testOsc = ctx.createOscillator();
    this.testOsc.type = 'sine';
    this.testOsc.frequency.value = 220;
    this.testOsc.connect(this.testGain);
    this.testOsc.start();

    // Gentle fade in
    const vol = this.deps.settings.current.masterVolume;
    this.testGain.gain.setValueAtTime(0, ctx.currentTime);
    this.testGain.gain.linearRampToValueAtTime(vol * 0.3, ctx.currentTime + 1);
  }

  private setTestToneVolume(vol: number): void {
    if (!this.testGain) return;
    const ctx = this.deps.audio.context ?? this.testCtx;
    if (!ctx) return;
    this.testGain.gain.cancelScheduledValues(ctx.currentTime);
    this.testGain.gain.setTargetAtTime(vol * 0.3, ctx.currentTime, 0.05);
  }

  private stopTestTone(): void {
    if (this.testOsc) {
      this.testOsc.stop();
      this.testOsc = null;
    }
    this.testGain = null;
    if (this.testCtx) {
      this.testCtx.close();
      this.testCtx = null;
    }
  }

  // ── Input ──

  private waitForAdjustment(opts: {
    onLeft: () => void;
    onRight: () => void;
  }): Promise<void> {
    return new Promise((resolve) => {
      const handler = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.code === 'ArrowLeft' || e.code === 'ArrowDown') {
          opts.onLeft();
        } else if (e.code === 'ArrowRight' || e.code === 'ArrowUp') {
          opts.onRight();
        } else if (e.code === 'Space' || e.code === 'Enter') {
          window.removeEventListener('keydown', handler, true);
          this.keyHandler = null;
          resolve();
        } else if (e.code === 'Escape') {
          window.removeEventListener('keydown', handler, true);
          this.keyHandler = null;
          this.cancelled = true;
          resolve();
        }
      };
      this.keyHandler = handler;
      window.addEventListener('keydown', handler, true); // capture phase
    });
  }

  // ── Sprite helpers ──

  private addSprite(
    text: string, fontSize: number, color: string,
    x: number, y: number, z: number,
  ): THREE.Sprite {
    const sprite = this.makeTextSprite(text, fontSize, color);
    sprite.position.set(x, y, z);
    sprite.scale.set(0, 0, 1);
    (sprite.material as THREE.SpriteMaterial).opacity = 0;
    this.group.add(sprite);
    this.sprites.push(sprite);
    return sprite;
  }

  private makeTextSprite(text: string, fontSize: number, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = `300 ${fontSize}px Georgia, serif`;
    ctx.font = font;

    const metrics = ctx.measureText(text || 'M');
    const pad = fontSize * 0.8;
    canvas.width = Math.ceil(metrics.width + pad * 2);
    canvas.height = Math.ceil(fontSize * 2 + pad * 2);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = `${color}66`;
    ctx.shadowBlur = 20;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const sprite = new THREE.Sprite(material);
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(0.5 * aspect, 0.5, 1);
    // Store canvas/ctx on userData for updateSpriteText
    sprite.userData = { canvas, ctx, font, color, fontSize };
    return sprite;
  }

  private updateSpriteText(sprite: THREE.Sprite, text: string): void {
    const { canvas, ctx, font, color, fontSize } = sprite.userData;
    if (!canvas || !ctx) return;

    // Resize canvas if needed
    ctx.font = font;
    const metrics = ctx.measureText(text);
    const pad = fontSize * 0.8;
    const newW = Math.ceil(metrics.width + pad * 2);
    if (newW > canvas.width) {
      canvas.width = newW;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = `${color}66`;
    ctx.shadowBlur = 20;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const mat = sprite.material as THREE.SpriteMaterial;
    mat.map!.needsUpdate = true;

    // Update aspect
    const aspect = canvas.width / canvas.height;
    const currentScaleY = sprite.scale.y;
    sprite.scale.set(currentScaleY * aspect, currentScaleY, 1);
  }

  private animateIn(sprite: THREE.Sprite, durationMs: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    const mat = sprite.material as THREE.SpriteMaterial;
    const targetScale = sprite.scale.clone();
    const aspect = targetScale.x / Math.max(targetScale.y, 0.001);
    const start = performance.now();

    return new Promise((resolve) => {
      const tick = () => {
        if (this.cancelled) { resolve(); return; }
        const t = Math.min(1, (performance.now() - start) / durationMs);
        const ease = 1 - (1 - t) * (1 - t);
        mat.opacity = ease * 0.9;
        const s = targetScale.y * ease;
        sprite.scale.set(s * aspect, s, 1);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private animateOut(sprite: THREE.Sprite, durationMs: number): void {
    const mat = sprite.material as THREE.SpriteMaterial;
    const startOpacity = mat.opacity;
    const start = performance.now();

    const tick = () => {
      if (this.cancelled) return;
      const t = Math.min(1, (performance.now() - start) / durationMs);
      mat.opacity = startOpacity * (1 - t);
      if (t >= 1) sprite.visible = false;
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private async showMessage(text: string, durationMs: number): Promise<void> {
    const sprite = this.addSprite(text, 44, '#a8e6cf', 0, 0.1, -1.8);
    await this.animateIn(sprite, 1000);
    await this.sleep(durationMs);
    this.animateOut(sprite, 800);
    await this.sleep(900);
  }

  // ── Util ──

  private fmtVal(v: number, unit: string): string {
    return v.toFixed(1) + unit;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private cleanup(): void {
    this._active = false;
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
    this.stopTestTone();
    for (const sprite of this.sprites) {
      this.group.remove(sprite);
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    this.sprites = [];
    this.deps.scene.remove(this.group);
  }
}
