/**
 * Interaction layer — fully 3D, QTE-style prompts.
 * Big, prominent action indicators at center-bottom, close to the user.
 * Breath-sync has a ring that fills, gates have pulsing action buttons,
 * everything feels like a game's quicktime event.
 */

import * as THREE from 'three';
import type { Interaction } from './session';
import type { MicSignals } from './microphone';
import type { BreathController, BreathStage } from './breath';
import { Text3D } from './text3d';
import type { NarrationEngine } from './narration';
import { BreathingGuide } from './breathing-guide';
import { isTouchDevice, tapLabel } from './touch';
import type { EventBus } from './events';

/** Shader-readable state for breath-sync and hum-sync effects */
export interface InteractionShaderState {
  breathSyncActive: number;
  breathSyncFill: number;
  breathSyncProgress: number; // 0-1 (goodCycles / 4)
  humSyncActive: number;
  humProgress: number;
}

// QTE positioning — close to camera, anchored at bottom
const QTE_Z = -0.8;       // close to user (in front of narration text)
const QTE_Y = -0.35;      // low in the view, clear of narration text
const QTE_LABEL_Y = -0.52; // label sits below the ring
const QTE_SIZE = 512;      // canvas resolution for ring/button textures

export class InteractionManager {
  private active: Interaction | null = null;
  private startTime = 0;
  private onComplete: (() => void) | null = null;
  private breath: BreathController;
  private micSignalsGetter: (() => MicSignals) | null = null;
  private spaceHeld = false;

  // 3D deps
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private canvas: HTMLCanvasElement;
  private text3d: Text3D;
  private narration: NarrationEngine;
  private group: THREE.Group;
  private bus: EventBus | null = null;
  private busUnsubs: Array<() => void> = [];

  // QTE prompt sprite (the main ring/button — used by gates/countdown/hum/affirm)
  private qteSprite: THREE.Sprite | null = null;
  private qteCanvas: HTMLCanvasElement | null = null;
  private qteCtx: CanvasRenderingContext2D | null = null;
  private qteTexture: THREE.CanvasTexture | null = null;

  // Secondary label sprite (instruction text below ring)
  private qteLabelSprite: THREE.Sprite | null = null;
  private qteLabelCanvas: HTMLCanvasElement | null = null;
  private qteLabelCtx: CanvasRenderingContext2D | null = null;
  private qteLabelTexture: THREE.CanvasTexture | null = null;

  // Gate sprites for raycasting
  private gateButton: THREE.Sprite | null = null;

  // Countdown
  private countdownSprite: THREE.Sprite | null = null;
  private countdownState = {
    current: 0,
    lastNumberTime: 0,
  };

  // Breath sync
  private breathSyncReady = false; // true once intro is done and ring is created
  private breathSyncState: {
    isHolding: boolean;
    goodCycles: number;
    lastPhaseWasInhale: boolean;
    syncAccuracy: number;
    lastBreathVal?: number;
    cycleStarted: boolean;
    smoothVal: number;
    lastStage: string;
    labelOpacity: number;
  } = {
    isHolding: false,
    goodCycles: 0,
    lastPhaseWasInhale: false,
    syncAccuracy: 0,
    lastBreathVal: undefined,
    cycleStarted: false,
    smoothVal: 0,
    lastStage: '',
    labelOpacity: 1,
  };
  private breathOrbs: Array<{
    mesh: THREE.Mesh;
    spawnPhase: number;    // breath phase when this orb was spawned
    cycle: number;         // which breath cycle this orb belongs to
  }> = [];
  private breathOrbGeometry: THREE.SphereGeometry | null = null;
  private breathProgressOrbs: THREE.Mesh[] = [];

  // Hum sync
  private humSyncState = {
    humDuration: 0,
    targetDuration: 15,
    lastHumming: false,
  };

  // Affirm
  private affirmState = {
    detected: false,
    waitStart: 0,
  };

  // Pending timers — cleared on clear() to prevent stale callbacks
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  // Shader state (read by main.ts each frame)
  private _shaderState: InteractionShaderState = {
    breathSyncActive: 0,
    breathSyncFill: 0,
    breathSyncProgress: 0,
    humSyncActive: 0,
    humProgress: 0,
  };

  constructor(
    breath: BreathController,
    scene: THREE.Scene,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    text3d: Text3D,
    narration: NarrationEngine,
  ) {
    this.breath = breath;
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.text3d = text3d;
    this.narration = narration;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.bindSpacebar();
  }

  /** Move the interaction plane to a new depth */
  setDepth(z: number): void {
    this.group.position.z = z;
  }

  /** Scale interaction elements (x/y only to preserve depth) */
  setScale(s: number): void {
    this.group.scale.set(s, s, 1);
  }

  /** Connect to event bus — enables bus-driven input */
  setBus(bus: EventBus): void {
    // Clean up previous subs
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
    this.bus = bus;
    this.bindBusInput();
  }

  setMicSignals(getter: () => MicSignals): void {
    this.micSignalsGetter = getter;
  }

  private presenceControl: { breatheMode: () => void; sessionMode: () => void; getPresence: () => import('./presence').Presence | null } | null = null;

  setPresenceControl(ctrl: { breatheMode: () => void; sessionMode: () => void; getPresence: () => import('./presence').Presence | null }): void {
    this.presenceControl = ctrl;
  }

  get shaderState(): InteractionShaderState {
    return this._shaderState;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  private bindSpacebar(): void {
    // Legacy fallback — does nothing if bus is connected (bindBusInput handles it)
  }

  /** Bus-driven input — replaces all the old DOM listeners in bindSpacebar */
  private bindBusInput(): void {
    if (!this.bus) return;

    // Back = skip interaction
    this.busUnsubs.push(this.bus.on('input:back', () => {
      if (this.active) this.resolve();
    }));

    // Confirm = resolve gate/focus/affirm; also triggers hold-start for breath-sync
    this.busUnsubs.push(this.bus.on('input:confirm', () => {
      if (!this.active) return;
      switch (this.active.type) {
        case 'focus-target':
        case 'gate':
        case 'voice-gate':
          this.resolve();
          break;
        case 'affirm':
          if (!this.affirmState.detected) this.affirmState.detected = true;
          break;
      }
    }));

    // Hold start = breath-sync inhale, hum-sync activate
    this.busUnsubs.push(this.bus.on('input:hold-start', () => {
      if (!this.active) return;
      this.spaceHeld = true;
      if (this.active.type === 'breath-sync') this.breathSyncState.isHolding = true;
      if (this.active.type === 'hum-sync') this.humSyncState.lastHumming = true;
    }));

    // Hold end = breath-sync exhale, hum-sync deactivate
    this.busUnsubs.push(this.bus.on('input:hold-end', () => {
      this.spaceHeld = false;
      if (!this.active) return;
      if (this.active.type === 'breath-sync') this.breathSyncState.isHolding = false;
      if (this.active.type === 'hum-sync') this.humSyncState.lastHumming = false;
    }));
  }

  start(interaction: Interaction): Promise<void> {
    this.clear();
    this.active = interaction;
    this.startTime = performance.now() / 1000;

    return new Promise<void>((resolve) => {
      this.onComplete = resolve;

      switch (interaction.type) {
        case 'focus-target':
          this.startFocusTarget();
          break;
        case 'breath-sync':
          this.startBreathSync();
          break;
        case 'gate':
          this.startGate(interaction);
          break;
        case 'voice-gate':
          this.startVoiceGate(interaction);
          break;
        case 'countdown':
          this.startCountdown(interaction);
          break;
        case 'hum-sync':
          this.startHumSync(interaction);
          break;
        case 'affirm':
          this.startAffirm(interaction);
          break;
      }
    });
  }

  /** Call every frame. breathValue is 0-1 (same as shader breathe(): sin(phase)*0.5+0.5) */
  update(time: number, _intensity: number, breathValue?: number): void {
    if (!this.active) return;

    switch (this.active.type) {
      case 'breath-sync':
        if (this.breathSyncReady) {
          this.updateBreathSync(breathValue ?? this.breath.value);
        }
        break;
      case 'countdown':
        this.updateCountdown(time);
        break;
      case 'gate':
        this.updateGate();
        break;
      case 'voice-gate':
        this.updateVoiceGate();
        break;
      case 'hum-sync':
        this.updateHumSync();
        break;
      case 'affirm':
        this.updateAffirm();
        break;
    }
  }

  skip(): void {
    this.resolve();
  }

  clear(): void {
    // Cancel all pending timers to prevent stale callbacks
    for (const id of this.pendingTimers) clearTimeout(id);
    this.pendingTimers.clear();

    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      if (child instanceof THREE.Sprite) {
        const mat = child.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
      } else if (child instanceof THREE.Mesh) {
        (child.material as THREE.Material).dispose();
      }
    }

    this.active = null;
    this.onComplete = null;
    this.gateButton = null;
    this.qteSprite = null;
    this.qteCanvas = null;
    this.qteCtx = null;
    this.qteTexture = null;
    this.qteLabelSprite = null;
    this.qteLabelCanvas = null;
    this.qteLabelCtx = null;
    this.qteLabelTexture = null;
    this.countdownSprite = null;
    this.breathOrbs = [];
    this.breathProgressOrbs = [];
    this.breathSyncReady = false;
    if (this.breathOrbGeometry) { this.breathOrbGeometry.dispose(); this.breathOrbGeometry = null; }
    this.breathSyncState = { isHolding: false, goodCycles: 0, lastPhaseWasInhale: false, syncAccuracy: 0, lastBreathVal: undefined, cycleStarted: false, smoothVal: 0, lastStage: '', labelOpacity: 1 };
    this.countdownState = { current: 0, lastNumberTime: 0 };
    this.humSyncState = { humDuration: 0, targetDuration: 15, lastHumming: false };
    this.affirmState = { detected: false, waitStart: 0 };

    this._shaderState = {
      breathSyncActive: 0,
      breathSyncFill: 0,
      breathSyncProgress: 0,
      humSyncActive: 0,
      humProgress: 0,
    };
  }

  private resolve(): void {
    const cb = this.onComplete;
    this.text3d.fadeOut(); // fade out any prompt text gracefully
    this.clear();
    if (cb) cb();
  }

  // ── QTE Prompt Helpers ──

  /** Create the main QTE ring/circle sprite */
  private createQteRing(): void {
    const canvas = document.createElement('canvas');
    canvas.width = QTE_SIZE;
    canvas.height = QTE_SIZE;
    this.qteCanvas = canvas;
    this.qteCtx = canvas.getContext('2d')!;
    this.qteTexture = new THREE.CanvasTexture(canvas);
    this.qteTexture.minFilter = THREE.LinearFilter;
    this.qteTexture.magFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
      map: this.qteTexture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.qteSprite = new THREE.Sprite(mat);
    this.qteSprite.scale.set(0.5, 0.5, 1);
    this.qteSprite.position.set(0, QTE_Y, QTE_Z);
    this.group.add(this.qteSprite);

    // Fade in
    const start = performance.now();
    const fadeIn = () => {
      const t = Math.min(1, (performance.now() - start) / 600);
      mat.opacity = t * 0.75;
      if (t < 1) requestAnimationFrame(fadeIn);
    };
    requestAnimationFrame(fadeIn);
  }

  /** Create a label sprite below the QTE ring */
  private createQteLabel(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 80;
    this.qteLabelCanvas = canvas;
    this.qteLabelCtx = canvas.getContext('2d')!;
    this.qteLabelTexture = new THREE.CanvasTexture(canvas);
    this.qteLabelTexture.minFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
      map: this.qteLabelTexture,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.qteLabelSprite = new THREE.Sprite(mat);
    this.qteLabelSprite.scale.set(0.5, 0.08, 1);
    this.qteLabelSprite.position.set(0, QTE_LABEL_Y, QTE_Z);
    this.group.add(this.qteLabelSprite);
  }

  private updateQteLabel(text: string, color = '#c8a0ff'): void {
    if (!this.qteLabelCtx || !this.qteLabelCanvas || !this.qteLabelTexture) return;
    const ctx = this.qteLabelCtx;
    const w = this.qteLabelCanvas.width;
    const h = this.qteLabelCanvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.font = '300 32px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, w / 2, h / 2);
    ctx.shadowColor = `${color}88`;
    ctx.shadowBlur = 15;
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h / 2);
    ctx.shadowBlur = 0;

    this.qteLabelTexture.needsUpdate = true;
  }

  /** Draw a ring with arc fill — the core QTE visual */
  private drawRing(opts: {
    fill: number;           // 0-1 arc fill
    progress: number;       // 0-1 overall progress (dots)
    totalDots: number;
    completedDots: number;
    centerText: string;
    ringColor: string;
    fillColor: string;
    active: boolean;        // is the user pressing/holding
    pulse: number;          // 0-1 pulse phase
  }): void {
    if (!this.qteCtx || !this.qteCanvas || !this.qteTexture) return;
    const ctx = this.qteCtx;
    const s = QTE_SIZE;
    const cx = s / 2;
    const cy = s / 2;
    const r = s * 0.38;
    const lineW = s * 0.04;

    ctx.clearRect(0, 0, s, s);

    // Outer ring glow
    const glowSize = opts.active ? 25 : 12;
    ctx.shadowColor = opts.fillColor;
    ctx.shadowBlur = glowSize;

    // Background ring (dim)
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `${opts.ringColor}33`;
    ctx.lineWidth = lineW;
    ctx.stroke();

    // Fill arc (clockwise from top)
    if (opts.fill > 0) {
      ctx.beginPath();
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + opts.fill * Math.PI * 2;
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.strokeStyle = opts.fillColor;
      ctx.lineWidth = lineW + (opts.active ? 4 : 0);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.shadowBlur = 0;

    // Active state: inner glow
    if (opts.active) {
      const pulseAlpha = 0.08 + opts.pulse * 0.08;
      const innerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.85);
      innerGrad.addColorStop(0, `${opts.fillColor}${Math.round(pulseAlpha * 255).toString(16).padStart(2, '0')}`);
      innerGrad.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
      ctx.fillStyle = innerGrad;
      ctx.fill();
    }

    // Center text (e.g. "HOLD", "RELEASE", countdown number)
    ctx.font = `600 ${s * 0.14}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(opts.centerText, cx, cy);
    ctx.shadowColor = `${opts.fillColor}88`;
    ctx.shadowBlur = 20;
    ctx.fillStyle = opts.fillColor;
    ctx.fillText(opts.centerText, cx, cy);
    ctx.shadowBlur = 0;

    // Progress dots below center
    if (opts.totalDots > 0) {
      const dotR = s * 0.02;
      const dotSpacing = s * 0.06;
      const dotY = cy + r * 0.55;
      const dotsWidth = (opts.totalDots - 1) * dotSpacing;

      for (let i = 0; i < opts.totalDots; i++) {
        const dx = cx - dotsWidth / 2 + i * dotSpacing;
        ctx.beginPath();
        ctx.arc(dx, dotY, dotR, 0, Math.PI * 2);
        if (i < opts.completedDots) {
          ctx.fillStyle = opts.fillColor;
          ctx.shadowColor = opts.fillColor;
          ctx.shadowBlur = 8;
        } else {
          ctx.fillStyle = `${opts.ringColor}44`;
          ctx.shadowBlur = 0;
        }
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    // Key hint at bottom
    const hintY = cy + r * 0.78;
    ctx.font = `300 ${s * 0.05}px Georgia, serif`;
    ctx.fillStyle = `${opts.ringColor}88`;
    ctx.fillText('space / tap', cx, hintY);

    this.qteTexture.needsUpdate = true;
  }

  /** Draw a pulsing action button — for gates/confirms */
  private drawActionButton(opts: {
    text: string;
    color: string;
    pulse: number;
    hint?: string;
  }): void {
    if (!this.qteCtx || !this.qteCanvas || !this.qteTexture) return;
    const ctx = this.qteCtx;
    const s = QTE_SIZE;
    const cx = s / 2;
    const cy = s / 2;
    const r = s * 0.32;

    ctx.clearRect(0, 0, s, s);

    // Pulsing outer ring
    const pulseR = r + opts.pulse * s * 0.04;
    const pulseAlpha = 0.3 + opts.pulse * 0.3;

    // Outer glow ring
    ctx.beginPath();
    ctx.arc(cx, cy, pulseR + 8, 0, Math.PI * 2);
    ctx.strokeStyle = `${opts.color}${Math.round(pulseAlpha * 0.4 * 255).toString(16).padStart(2, '0')}`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Main ring
    ctx.shadowColor = opts.color;
    ctx.shadowBlur = 20 + opts.pulse * 15;
    ctx.beginPath();
    ctx.arc(cx, cy, pulseR, 0, Math.PI * 2);
    ctx.strokeStyle = `${opts.color}${Math.round(pulseAlpha * 255).toString(16).padStart(2, '0')}`;
    ctx.lineWidth = s * 0.025;
    ctx.stroke();

    // Inner fill glow
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.9);
    grad.addColorStop(0, `${opts.color}${Math.round(pulseAlpha * 0.15 * 255).toString(16).padStart(2, '0')}`);
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Center text
    ctx.font = `600 ${s * 0.16}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(opts.text, cx, cy);
    ctx.shadowColor = `${opts.color}aa`;
    ctx.shadowBlur = 25;
    ctx.fillStyle = opts.color;
    ctx.fillText(opts.text, cx, cy);
    ctx.shadowBlur = 0;

    // Hint
    const hintText = opts.hint ?? 'space / tap';
    const hintY = cy + r * 0.7;
    ctx.font = `300 ${s * 0.055}px Georgia, serif`;
    ctx.fillStyle = `${opts.color}88`;
    ctx.fillText(hintText, cx, hintY);

    this.qteTexture.needsUpdate = true;
  }

  // ── Sprite helpers ──

  private makeTextSprite(text: string, fontSize: number, color = '#c8a0ff', glow = 'rgba(200,160,255,0.4)'): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = `300 ${fontSize}px Georgia, serif`;
    ctx.font = font;

    const metrics = ctx.measureText(text);
    const pad = fontSize * 0.7;
    canvas.width = Math.ceil(metrics.width + pad * 2);
    canvas.height = Math.ceil(fontSize * 2 + pad * 2);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 3;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2);

    ctx.shadowColor = glow;
    ctx.shadowBlur = 20;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const sprite = new THREE.Sprite(material);
    const aspect = canvas.width / canvas.height;
    const scale = 0.3;
    sprite.scale.set(scale * aspect, scale, 1);
    return sprite;
  }

  // ── Focus Target ──

  private startFocusTarget(): void {
    this.text3d.show('focus on the center', 6);
    this.safeTimeout(() => {
      if (this.active?.type === 'focus-target') this.resolve();
    }, 6000);
  }

  // ── Breath Sync — Big centered breathing guide ──
  //
  // A large ring in the center of the screen that expands/contracts
  // with the breath cycle. Shows the current stage (IN / HOLD / OUT)
  // and a countdown of seconds remaining in that stage.
  // Progress dots show completed cycles.

  private async startBreathSync(): Promise<void> {
    // Intro — cue mode (same position as in/hold/out)
    this.text3d.showCue('let\u2019s breathe together');
    await this.playSharedClip('breathing_intro');
    await this.sleep(800);
    if (!this.active) return;

    this.text3d.hideCue();
    await this.sleep(500);

    // Activate breath-sync shader effects
    this._shaderState.breathSyncActive = 1;

    // Breathing guide owns wisp + cue text + timing
    const p = this.presenceControl?.getPresence() ?? undefined;
    const guide = new BreathingGuide(this.text3d, this.breath, p);
    await guide.run({ breaths: 4, showText: true });

    if (!this.active) return;

    // Outro — cue mode, same position
    this.text3d.showCue('continue breathing');
    this.playSharedClip('breathing_good');
    await this.sleep(3000);
    if (!this.active) return;

    this.text3d.showCue('just like that');
    await this.sleep(3000);
    if (!this.active) return;

    // Gentle fade before next stage
    this.text3d.hideCue();
    await this.sleep(2000);

    this.text3d.clearCue();
    this.text3d.clearSlotDepth();
    this._shaderState.breathSyncActive = 0;
    this.resolve();
  }

  /** Play a clip from the shared audio folder */
  private async playSharedClip(name: string): Promise<void> {
    try {
      const resp = await fetch('audio/shared/manifest.json');
      if (!resp.ok) return;
      const manifest = await resp.json();
      const clip = manifest.clips?.[name];
      if (!clip) return;

      return new Promise<void>(resolve => {
        const audio = new Audio(clip.file);
        audio.volume = 0.8;
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.play().catch(() => resolve());
        setTimeout(() => resolve(), (clip.duration + 2) * 1000); // safety timeout
      });
    } catch {
      // No shared audio available — continue silently
    }
  }

  /** Wait until the breath is at its lowest point (exhale trough) so the ring
   *  starts perfectly synced with a fresh inhale. Times out after 10s. */
  private waitForBreathValley(): Promise<void> {
    return new Promise(resolve => {
      const start = performance.now();
      const check = () => {
        if (!this.active) { resolve(); return; }
        if (performance.now() - start > 10000) { resolve(); return; } // timeout
        if (this.breath.value < 0.08 && this.breath.stage === 'inhale') {
          resolve(); // fresh inhale just starting
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
  }

  /** setTimeout that auto-cancels on clear() — prevents stale callbacks */
  private safeTimeout(fn: () => void, ms: number): void {
    const id = setTimeout(() => {
      this.pendingTimers.delete(id);
      if (this.active) fn();
    }, ms);
    this.pendingTimers.add(id);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private updateBreathSync(breathVal: number): void {
    const { isHolding } = this.breathSyncState;
    const stage = this.breath.stage;
    const isInhale = stage === 'inhale' || stage === 'hold-in';

    // In sync = holding during inhale/hold-in, releasing during exhale/hold-out
    const inSync = (isInhale && isHolding) || (!isInhale && !isHolding);

    this._shaderState.breathSyncFill = inSync ? breathVal : 0;
    this._shaderState.breathSyncProgress = this.breathSyncState.goodCycles / 4;

    // ── Smooth the breath value for visuals (no sudden jumps) ──
    const lerpSpeed = 0.06; // lower = smoother, higher = more responsive
    this.breathSyncState.smoothVal += (breathVal - this.breathSyncState.smoothVal) * lerpSpeed;
    const sv = this.breathSyncState.smoothVal;

    // ── Detect stage change → brief label fade ──
    if (stage !== this.breathSyncState.lastStage && this.breathSyncState.lastStage !== '') {
      this.breathSyncState.labelOpacity = 0; // flash to 0, will fade back in
    }
    this.breathSyncState.lastStage = stage;
    // Fade label back in
    this.breathSyncState.labelOpacity = Math.min(1, this.breathSyncState.labelOpacity + 0.04);

    // ── Move the prompt in Z with the smoothed breath ──
    if (this.qteSprite) {
      const farZ = -1.0;
      const closeZ = -0.5;
      const z = farZ + (closeZ - farZ) * sv;
      this.qteSprite.position.z = z;

      // Scale also breathes subtly
      const baseScale = 0.75;
      const breathScale = baseScale + sv * 0.15;
      this.qteSprite.scale.set(breathScale, breathScale, 1);
    }

    // ── Calculate seconds remaining in current breath stage ──
    const cycleProgress = this.breath.cycleProgress;
    const total = this.breath.cycleDuration;
    const cycleTime = cycleProgress * total;
    let stageSecondsLeft = 0;
    let stageLabel = '';
    const p = this.breath; // shorthand

    const pat = p.pattern;

    if (stage === 'inhale') {
      stageLabel = 'IN';
      stageSecondsLeft = pat.inhale - cycleTime;
    } else if (stage === 'hold-in') {
      stageLabel = 'HOLD';
      stageSecondsLeft = (pat.inhale + pat.holdIn) - cycleTime;
    } else if (stage === 'exhale') {
      stageLabel = 'OUT';
      stageSecondsLeft = (pat.inhale + pat.holdIn + pat.exhale) - cycleTime;
    } else {
      stageLabel = 'HOLD';
      stageSecondsLeft = total - cycleTime;
    }

    const countdown = Math.max(1, Math.ceil(stageSecondsLeft));

    // ── Draw the breathing ring ──
    const fillColor = inSync ? '#a8e6cf' : '#c8a0ff';
    const ringColor = '#c8a0ff';

    this.drawBreathGuide({
      breathVal: sv,  // use smoothed value for visuals
      stageLabel,
      countdown,
      ringColor,
      fillColor,
      active: isHolding,
      inSync,
      labelOpacity: this.breathSyncState.labelOpacity,
      goodCycles: this.breathSyncState.goodCycles,
    });

    // ── Detect cycle boundary ──
    const atValley = this.breathSyncState.lastBreathVal !== undefined
      && this.breathSyncState.lastBreathVal < 0.05
      && breathVal > this.breathSyncState.lastBreathVal
      && this.breathSyncState.cycleStarted;
    const atPeak = this.breathSyncState.lastBreathVal !== undefined
      && this.breathSyncState.lastBreathVal > 0.9
      && breathVal <= this.breathSyncState.lastBreathVal;

    if (atPeak) this.breathSyncState.cycleStarted = true;

    if (atValley) {
      this.breathSyncState.cycleStarted = false;

      if (this.breathSyncState.syncAccuracy > 0.5) {
        this.breathSyncState.goodCycles++;
        this._shaderState.breathSyncProgress = this.breathSyncState.goodCycles / 4;

        if (this.breathSyncState.goodCycles >= 4) {
          this.safeTimeout(() => this.resolve(), 800);
          this.breathSyncState.lastBreathVal = breathVal;
          return;
        }
      }
      this.breathSyncState.syncAccuracy = 0;
    }

    this.breathSyncState.syncAccuracy += inSync ? 0.016 : -0.008;
    this.breathSyncState.syncAccuracy = Math.max(0, Math.min(1, this.breathSyncState.syncAccuracy));
    this.breathSyncState.lastBreathVal = breathVal;
  }

  /** Draw the big centered breathing guide */
  private drawBreathGuide(opts: {
    breathVal: number;
    stageLabel: string;
    countdown: number;
    ringColor: string;
    fillColor: string;
    active: boolean;
    inSync: boolean;
    goodCycles: number;
    labelOpacity: number;
  }): void {
    if (!this.qteCtx || !this.qteCanvas || !this.qteTexture) return;
    const ctx = this.qteCtx;
    const s = QTE_SIZE;
    const cx = s / 2;
    const cy = s / 2;

    // Ring radius breathes — expands on inhale, contracts on exhale
    const baseR = s * 0.28;
    const breathR = baseR + opts.breathVal * s * 0.1;
    const lineW = s * 0.025;

    ctx.clearRect(0, 0, s, s);

    // Soft glow — present but controlled
    ctx.shadowColor = opts.fillColor;
    ctx.shadowBlur = 8;

    // Background ring (always visible)
    ctx.beginPath();
    ctx.arc(cx, cy, breathR, 0, Math.PI * 2);
    ctx.strokeStyle = `${opts.ringColor}28`;
    ctx.lineWidth = lineW;
    ctx.stroke();

    // Fill ring — tracks breath smoothly, capped so it never blows out
    ctx.beginPath();
    ctx.arc(cx, cy, breathR, 0, Math.PI * 2);
    const fillAlpha = Math.round((0.12 + opts.breathVal * 0.20) * 255);
    ctx.strokeStyle = `${opts.fillColor}${fillAlpha.toString(16).padStart(2, '0')}`;
    ctx.lineWidth = lineW;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Inner glow — soft but visible
    const innerAlpha = 0.02 + opts.breathVal * 0.05;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, breathR * 0.85);
    grad.addColorStop(0, `${opts.fillColor}${Math.round(innerAlpha * 255).toString(16).padStart(2, '0')}`);
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(cx, cy, breathR * 0.85, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Sync indicator
    if (opts.inSync) {
      ctx.beginPath();
      ctx.arc(cx, cy, breathR + lineW + 2, 0, Math.PI * 2);
      ctx.strokeStyle = `${opts.fillColor}40`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ── Stage label (IN / HOLD / OUT) — large, centered, fades on transition ──
    const la = opts.labelOpacity;
    ctx.globalAlpha = la;
    ctx.font = `200 ${s * 0.14}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = `rgba(0,0,0,${0.4 * la})`;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    const labelY = cy - s * 0.03;
    ctx.strokeText(opts.stageLabel, cx, labelY);
    ctx.fillStyle = `${opts.fillColor}cc`;
    ctx.fillText(opts.stageLabel, cx, labelY);

    // ── Countdown seconds ── smaller, below the label
    ctx.font = `100 ${s * 0.09}px Georgia, serif`;
    const countY = cy + s * 0.06;
    ctx.fillStyle = `${opts.fillColor}77`;
    ctx.fillText(String(opts.countdown), cx, countY);
    ctx.globalAlpha = 1;

    // ── Progress dots (4 cycles needed) ──
    const dotR = s * 0.015;
    const dotSpacing = s * 0.05;
    const dotY = cy + s * 0.16;
    const dotsWidth = 3 * dotSpacing;

    for (let i = 0; i < 4; i++) {
      const dx = cx - dotsWidth / 2 + i * dotSpacing;
      ctx.beginPath();
      ctx.arc(dx, dotY, dotR, 0, Math.PI * 2);
      if (i < opts.goodCycles) {
        ctx.fillStyle = opts.fillColor;
        ctx.shadowColor = opts.fillColor;
        ctx.shadowBlur = 6;
      } else {
        ctx.fillStyle = `${opts.ringColor}33`;
        ctx.shadowBlur = 0;
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // ── Hint text at bottom ──
    const hintY = cy + s * 0.24;
    ctx.font = `300 ${s * 0.04}px Georgia, serif`;
    ctx.fillStyle = `${opts.ringColor}66`;
    const breathHint = isTouchDevice()
      ? 'hold screen to inhale \u00B7 release to exhale'
      : 'hold space to inhale \u00B7 release to exhale';
    ctx.fillText(breathHint, cx, hintY);

    this.qteTexture.needsUpdate = true;
  }

  // ── Gate — QTE Action Button ──

  private startGate(interaction: Interaction): void {
    const questionText = interaction.data?.text ?? 'do you want to go deeper?';
    this.text3d.showInstant(questionText, 30);

    this.createQteRing();
    this.gateButton = this.qteSprite;
    // Click/tap handled by bus input:confirm → resolve in bindBusInput
  }

  private updateGate(): void {
    const pulse = Math.sin(performance.now() / 1000 * 2) * 0.5 + 0.5;
    this.drawActionButton({
      text: 'YES',
      color: '#c8a0ff',
      pulse,
    });
  }

  // ── Voice Gate — QTE with mic prompt ──

  private startVoiceGate(interaction: Interaction): void {
    const questionText = interaction.data?.text ?? 'do you want to go deeper?';
    this.text3d.showInstant(questionText, 30);

    this.createQteRing();
    this.createQteLabel();

    this.safeTimeout(() => {
      if (this.active?.type === 'voice-gate') {
        this.updateQteLabel(tapLabel('speak or press space', 'speak or tap'));
      }
    }, 1500);

    this.gateButton = this.qteSprite;
    // Click/tap handled by bus input:confirm → resolve in bindBusInput
  }

  private updateVoiceGate(): void {
    const pulse = Math.sin(performance.now() / 1000 * 2) * 0.5 + 0.5;

    // Check mic
    if (this.micSignalsGetter) {
      const mic = this.micSignalsGetter();
      if (mic.active && mic.isVocalizing) {
        this.resolve();
        return;
      }
    }

    this.drawActionButton({
      text: 'YES',
      color: '#c8a0ff',
      pulse,
      hint: 'say it / space / tap',
    });
  }

  // ── Countdown — QTE Ring with numbers ──

  private startCountdown(interaction: Interaction): void {
    const startCount = interaction.data?.count ?? 10;
    this.countdownState.current = startCount;
    this.countdownState.lastNumberTime = performance.now() / 1000;

    this.createQteRing();
  }

  private updateCountdown(time: number): void {
    const elapsed = time - this.countdownState.lastNumberTime;
    const interval = 3;
    const progress = elapsed / interval;

    // Draw the ring with countdown number
    const countFill = 1 - progress; // drains over each interval
    const pulse = Math.sin(performance.now() / 1000 * 2) * 0.5 + 0.5;
    const text = this.countdownState.current <= 1 ? 'DEEP' : String(this.countdownState.current);

    this.drawRing({
      fill: countFill,
      progress: 0,
      totalDots: 0,
      completedDots: 0,
      centerText: text,
      ringColor: '#c8a0ff',
      fillColor: '#c8a0ff',
      active: false,
      pulse,
    });

    if (elapsed >= interval) {
      this.countdownState.current--;
      this.countdownState.lastNumberTime = time;

      if (this.countdownState.current <= 0) {
        this.safeTimeout(() => this.resolve(), 2000);
        this.countdownState.current = -999;
        return;
      }
    }
  }

  // ── Hum Sync — QTE Ring with progress ──

  private startHumSync(interaction: Interaction): void {
    this._shaderState.humSyncActive = 1;
    this.humSyncState.targetDuration = interaction.duration || 15;
    this.text3d.show('hum with the exhale', 8);

    this.createQteRing();
    this.createQteLabel();
    this.updateQteLabel(tapLabel('hum or hold space', 'hum or hold screen'));
  }

  private updateHumSync(): void {
    const elapsed = performance.now() / 1000 - this.startTime;

    if (elapsed > this.humSyncState.targetDuration + 5) {
      this.resolve();
      return;
    }

    const mic = this.micSignalsGetter?.();
    const isHumming = (mic?.active && mic.isHumming) || this.humSyncState.lastHumming;

    if (isHumming) {
      this.humSyncState.humDuration += 1 / 60;
    }

    const progress = Math.min(1, this.humSyncState.humDuration / this.humSyncState.targetDuration);
    this._shaderState.humProgress = progress;

    const pulse = Math.sin(performance.now() / 1000 * 3) * 0.5 + 0.5;

    this.drawRing({
      fill: progress,
      progress,
      totalDots: 0,
      completedDots: 0,
      centerText: isHumming ? 'HUM' : '...',
      ringColor: '#c8a0ff',
      fillColor: isHumming ? '#a8e6cf' : '#c8a0ff',
      active: isHumming,
      pulse,
    });

    if (isHumming) {
      this.updateQteLabel('keep going...', '#a8e6cf');
    }

    if (this.humSyncState.humDuration >= this.humSyncState.targetDuration) {
      this.safeTimeout(() => this.resolve(), 500);
    }
  }

  // ── Affirm — QTE Action Button ──

  private startAffirm(interaction: Interaction): void {
    const phrase = interaction.data?.affirmation ?? 'I am going deeper';
    this.text3d.showInstant(phrase, 10);
    this.affirmState.waitStart = performance.now() / 1000;
    this.affirmState.detected = false;

    this.createQteRing();
    this.createQteLabel();

    this.safeTimeout(() => {
      if (this.active?.type === 'affirm' && !this.affirmState.detected) {
        this.updateQteLabel('say it aloud', '#c8a0ff');
      }
    }, 1500);
  }

  private updateAffirm(): void {
    const mic = this.micSignalsGetter?.();
    const elapsed = performance.now() / 1000 - this.affirmState.waitStart;
    const pulse = Math.sin(performance.now() / 1000 * 2) * 0.5 + 0.5;

    if (!this.affirmState.detected) {
      if (mic?.active && mic.isVocalizing && elapsed > 1) {
        this.affirmState.detected = true;
      }
    }

    this.drawActionButton({
      text: 'SPEAK',
      color: '#c8a0ff',
      pulse,
      hint: 'say it / space',
    });

    if (this.affirmState.detected) {
      this.safeTimeout(() => this.resolve(), 1500);
      this.affirmState.detected = false;
      this.affirmState.waitStart = Infinity;
    }

    if (elapsed > (this.active?.duration ?? 8) + 3) {
      this.resolve();
    }
  }
}
