/**
 * Guided calibration — 3-step in-tunnel wizard.
 * Uses SpriteText for all text rendering (shared system).
 * Arrow keys / touch zones to adjust, Space / center-tap to confirm.
 */

import * as THREE from 'three';
import type { SettingsManager } from './settings';
import type { AudioEngine } from './audio';
import type { Text3D } from './text3d';
import { SpriteText } from './sprite-text';
import { isTouchDevice } from './touch';
import type { EventBus } from './events';

interface CalibrationDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  settings: SettingsManager;
  audio: AudioEngine;
  text3d: Text3D;
  bus: EventBus;
}

export class GuidedCalibration {
  private deps: CalibrationDeps;
  private group: THREE.Group;
  private sprites: THREE.Sprite[] = [];
  private _active = false;
  private cancelled = false;
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
    if (!this._active) return;
    const t = performance.now() / 1000;
    for (const sprite of this.sprites) {
      if (!sprite.visible) continue;
      sprite.position.y += Math.sin(t * 2) * 0.0002;
    }
  }

  // ── Steps ──

  private async runStepSpeed(): Promise<void> {
    const title = this.addText('tunnel speed', 0.12, '#c8a0ff', 0, 0.25, -2);
    const hintText = isTouchDevice()
      ? 'tap left = slower   tap right = faster   center = confirm'
      : '\u2190 slower   \u2192 faster   space = confirm';
    const hint = this.addText(hintText, 0.06, '#8060aa', 0, -0.05, -1.8, 28);
    const valueSprite = this.addText('1.0x', 0.08, '#a8e6cf', 0, 0.08, -1.8, 32);

    await this.animateIn(title, 1000);
    await this.animateIn(hint, 800);
    await this.animateIn(valueSprite, 500);
    if (this.cancelled) return;

    let speed = this.deps.settings.current.tunnelSpeed;
    this.updateText(valueSprite, this.fmtVal(speed, 'x'));

    await this.waitForAdjustment({
      onLeft: () => {
        speed = Math.max(0, speed - 0.1);
        this.deps.settings.updateBatch({ tunnelSpeed: speed });
        this.updateText(valueSprite, this.fmtVal(speed, 'x'));
      },
      onRight: () => {
        speed = Math.min(5, speed + 0.1);
        this.deps.settings.updateBatch({ tunnelSpeed: speed });
        this.updateText(valueSprite, this.fmtVal(speed, 'x'));
      },
    });

    this.animateOut(title, 600);
    this.animateOut(hint, 600);
    this.animateOut(valueSprite, 600);
    await this.sleep(700);
  }

  private async runStepText(): Promise<void> {
    this.deps.text3d.show('you are feeling calm and focused', 30);

    const title = this.addText('text readability', 0.12, '#c8a0ff', 0, 0.25, -2);
    const hintText = isTouchDevice()
      ? 'tap left = smaller   tap right = bigger   center = confirm'
      : '\u2190 smaller   \u2192 bigger   space = confirm';
    const hint = this.addText(hintText, 0.06, '#8060aa', 0, -0.05, -1.8, 28);
    const valueSprite = this.addText('1.0x', 0.08, '#a8e6cf', 0, 0.08, -1.8, 32);

    await this.animateIn(title, 1000);
    await this.animateIn(hint, 800);
    await this.animateIn(valueSprite, 500);
    if (this.cancelled) return;

    let scale = this.deps.settings.current.narrationScale;
    this.updateText(valueSprite, this.fmtVal(scale, 'x'));

    await this.waitForAdjustment({
      onLeft: () => {
        scale = Math.max(0.1, scale - 0.1);
        this.deps.settings.updateBatch({ narrationScale: scale });
        this.updateText(valueSprite, this.fmtVal(scale, 'x'));
      },
      onRight: () => {
        scale = Math.min(5, scale + 0.1);
        this.deps.settings.updateBatch({ narrationScale: scale });
        this.updateText(valueSprite, this.fmtVal(scale, 'x'));
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

    const title = this.addText('audio level', 0.12, '#c8a0ff', 0, 0.25, -2);
    const hintText = isTouchDevice()
      ? 'tap left = quieter   tap right = louder   center = confirm'
      : '\u2190 quieter   \u2192 louder   space = confirm';
    const hint = this.addText(hintText, 0.06, '#8060aa', 0, -0.05, -1.8, 28);
    const valueSprite = this.addText('100%', 0.08, '#a8e6cf', 0, 0.08, -1.8, 32);

    await this.animateIn(title, 1000);
    await this.animateIn(hint, 800);
    await this.animateIn(valueSprite, 500);
    if (this.cancelled) return;

    let vol = this.deps.settings.current.masterVolume;
    this.updateText(valueSprite, Math.round(vol * 100) + '%');

    await this.waitForAdjustment({
      onLeft: () => {
        vol = Math.max(0, vol - 0.05);
        this.deps.settings.updateBatch({ masterVolume: vol });
        this.setTestToneVolume(vol);
        this.updateText(valueSprite, Math.round(vol * 100) + '%');
      },
      onRight: () => {
        vol = Math.min(2, vol + 0.05);
        this.deps.settings.updateBatch({ masterVolume: vol });
        this.setTestToneVolume(vol);
        this.updateText(valueSprite, Math.round(vol * 100) + '%');
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
    const ctx = this.deps.audio.context ?? new AudioContext();
    this.testCtx = this.deps.audio.context ? null : ctx;

    this.testGain = ctx.createGain();
    this.testGain.gain.value = 0;
    this.testGain.connect(ctx.destination);

    this.testOsc = ctx.createOscillator();
    this.testOsc.type = 'sine';
    this.testOsc.frequency.value = 220;
    this.testOsc.connect(this.testGain);
    this.testOsc.start();

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
      const bus = this.deps.bus;
      const subs: Array<() => void> = [];
      const cleanup = () => { for (const u of subs) u(); };

      subs.push(bus.on('input:left', () => opts.onLeft()));
      subs.push(bus.on('input:right', () => opts.onRight()));
      subs.push(bus.on('input:confirm', () => { cleanup(); resolve(); }));
      subs.push(bus.on('input:back', () => { cleanup(); this.cancelled = true; resolve(); }));
    });
  }

  // ── Text helpers (using shared SpriteText) ──

  private addText(
    text: string, height: number, color: string,
    x: number, y: number, z: number,
    fontSize = 48,
  ): THREE.Sprite {
    const sprite = SpriteText.create(text, {
      height,
      fontSize,
      color,
      glow: `${color}66`,
    });
    sprite.position.set(x, y, z);
    // Store the intended scale, then zero it for animate-in
    sprite.userData._targetScale = sprite.scale.clone();
    sprite.scale.set(0, 0, 1);
    SpriteText.setOpacity(sprite, 0);
    this.group.add(sprite);
    this.sprites.push(sprite);
    return sprite;
  }

  private updateText(sprite: THREE.Sprite, text: string): void {
    SpriteText.updateText(sprite, text);
    // After updateText, scale is reset to the natural size — store it
    sprite.userData._targetScale = sprite.scale.clone();
  }

  private animateIn(sprite: THREE.Sprite, durationMs: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    const target = sprite.userData._targetScale as THREE.Vector3;
    if (!target) return Promise.resolve();
    const start = performance.now();

    return new Promise((resolve) => {
      const tick = () => {
        if (this.cancelled) { resolve(); return; }
        const t = Math.min(1, (performance.now() - start) / durationMs);
        const ease = 1 - (1 - t) * (1 - t);
        SpriteText.setOpacity(sprite, ease * 0.9);
        sprite.scale.set(target.x * ease, target.y * ease, 1);
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
    const sprite = this.addText(text, 0.1, '#a8e6cf', 0, 0.1, -1.8, 44);
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
    this.stopTestTone();
    for (const sprite of this.sprites) {
      this.group.remove(sprite);
      SpriteText.dispose(sprite);
    }
    this.sprites = [];
    this.deps.scene.remove(this.group);
  }
}
