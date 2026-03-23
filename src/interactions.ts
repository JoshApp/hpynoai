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
  private group: THREE.Group;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private clickHandler: ((e: MouseEvent) => void) | null = null;

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

  // Breath sync — floating orb rhythm game
  private breathSyncState: {
    isHolding: boolean;
    goodCycles: number;
    lastPhaseWasInhale: boolean;
    syncAccuracy: number;
    lastBreathVal?: number;
    cycleStarted: boolean;
  } = {
    isHolding: false,
    goodCycles: 0,
    lastPhaseWasInhale: false,
    syncAccuracy: 0,
    lastBreathVal: undefined,
    cycleStarted: false,
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
  ) {
    this.breath = breath;
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.text3d = text3d;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.bindSpacebar();
  }

  /** Move the interaction plane to a new depth */
  setDepth(z: number): void {
    this.group.position.z = z - (-1.2);
  }

  /** Scale interaction elements */
  setScale(s: number): void {
    this.group.scale.setScalar(s);
  }

  setMicSignals(getter: () => MicSignals): void {
    this.micSignalsGetter = getter;
  }

  get shaderState(): InteractionShaderState {
    return this._shaderState;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  private bindSpacebar(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (!this.active) return;
      if (this.spaceHeld) return;
      this.spaceHeld = true;

      switch (this.active.type) {
        case 'focus-target':
          this.resolve();
          break;
        case 'breath-sync':
          this.breathSyncState.isHolding = true;
          break;
        case 'gate':
        case 'voice-gate':
          this.resolve();
          break;
        case 'hum-sync':
          this.humSyncState.lastHumming = true;
          break;
        case 'affirm':
          if (!this.affirmState.detected) this.affirmState.detected = true;
          break;
      }
    });

    window.addEventListener('keyup', (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      this.spaceHeld = false;
      if (!this.active) return;
      if (this.active.type === 'breath-sync') this.breathSyncState.isHolding = false;
      if (this.active.type === 'hum-sync') this.humSyncState.lastHumming = false;
    });
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
        this.updateBreathSync(breathValue ?? this.breath.value);
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

    if (this.clickHandler) {
      this.canvas.removeEventListener('click', this.clickHandler);
      this.clickHandler = null;
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
    if (this.breathOrbGeometry) { this.breathOrbGeometry.dispose(); this.breathOrbGeometry = null; }
    this.breathSyncState = { isHolding: false, goodCycles: 0, lastPhaseWasInhale: false, syncAccuracy: 0, lastBreathVal: undefined, cycleStarted: false };
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
      mat.opacity = t * 0.9;
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
    setTimeout(() => {
      if (this.active?.type === 'focus-target') this.resolve();
    }, 6000);
  }

  // ── Breath Sync — Big centered breathing guide ──
  //
  // A large ring in the center of the screen that expands/contracts
  // with the breath cycle. Shows the current stage (IN / HOLD / OUT)
  // and a countdown of seconds remaining in that stage.
  // Progress dots show completed cycles.

  private startBreathSync(): void {
    this._shaderState.breathSyncActive = 1;

    // Big centered QTE ring for the breathing guide
    this.createQteRing();

    // Make it bigger and centered (not bottom-offset)
    if (this.qteSprite) {
      this.qteSprite.scale.set(0.8, 0.8, 1);
      this.qteSprite.position.set(0, 0, -0.7); // dead center, close
    }

    // Touch/click for mobile
    const onDown = () => { this.breathSyncState.isHolding = true; };
    const onUp = () => { this.breathSyncState.isHolding = false; };
    this.canvas.addEventListener('mousedown', onDown);
    this.canvas.addEventListener('touchstart', onDown, { passive: true });
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
  }

  private updateBreathSync(breathVal: number): void {
    const { isHolding } = this.breathSyncState;
    const stage = this.breath.stage;
    const isInhale = stage === 'inhale' || stage === 'hold-in';

    // In sync = holding during inhale/hold-in, releasing during exhale/hold-out
    const inSync = (isInhale && isHolding) || (!isInhale && !isHolding);

    this._shaderState.breathSyncFill = inSync ? breathVal : 0;
    this._shaderState.breathSyncProgress = this.breathSyncState.goodCycles / 4;

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
      breathVal,
      stageLabel,
      countdown,
      ringColor,
      fillColor,
      active: isHolding,
      inSync,
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
          setTimeout(() => this.resolve(), 800);
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

    // Outer glow
    ctx.shadowColor = opts.fillColor;
    ctx.shadowBlur = opts.active ? 30 : 15;

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, breathR, 0, Math.PI * 2);
    ctx.strokeStyle = `${opts.ringColor}22`;
    ctx.lineWidth = lineW;
    ctx.stroke();

    // Fill ring — opacity based on breath value
    ctx.beginPath();
    ctx.arc(cx, cy, breathR, 0, Math.PI * 2);
    const fillAlpha = Math.round((0.15 + opts.breathVal * 0.35) * 255);
    ctx.strokeStyle = `${opts.fillColor}${fillAlpha.toString(16).padStart(2, '0')}`;
    ctx.lineWidth = lineW + (opts.active ? 4 : 0);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Inner fill glow — subtle radial gradient that breathes
    const innerAlpha = 0.03 + opts.breathVal * 0.08;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, breathR * 0.9);
    grad.addColorStop(0, `${opts.fillColor}${Math.round(innerAlpha * 255).toString(16).padStart(2, '0')}`);
    grad.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.arc(cx, cy, breathR * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Sync indicator — thin bright ring when synced
    if (opts.inSync) {
      ctx.beginPath();
      ctx.arc(cx, cy, breathR + lineW + 3, 0, Math.PI * 2);
      ctx.strokeStyle = `${opts.fillColor}55`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ── Stage label (IN / HOLD / OUT) — large, centered ──
    ctx.font = `200 ${s * 0.14}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    const labelY = cy - s * 0.03;
    ctx.strokeText(opts.stageLabel, cx, labelY);
    ctx.shadowColor = `${opts.fillColor}66`;
    ctx.shadowBlur = 15;
    ctx.fillStyle = opts.fillColor;
    ctx.fillText(opts.stageLabel, cx, labelY);
    ctx.shadowBlur = 0;

    // ── Countdown seconds ── smaller, below the label
    ctx.font = `100 ${s * 0.09}px Georgia, serif`;
    const countY = cy + s * 0.06;
    ctx.fillStyle = `${opts.fillColor}99`;
    ctx.fillText(String(opts.countdown), cx, countY);

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
    ctx.fillText('hold space to inhale \u00B7 release to exhale', cx, hintY);

    this.qteTexture.needsUpdate = true;
  }

  // ── Gate — QTE Action Button ──

  private startGate(interaction: Interaction): void {
    const questionText = interaction.data?.text ?? 'do you want to go deeper?';
    this.text3d.showInstant(questionText, 30);

    this.createQteRing();

    // Also make the ring clickable via raycasting
    this.gateButton = this.qteSprite;
    this.clickHandler = (e: MouseEvent) => {
      this.pointer.x = (e.clientX / this.canvas.clientWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / this.canvas.clientHeight) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      if (this.qteSprite) {
        const hits = this.raycaster.intersectObject(this.qteSprite);
        if (hits.length > 0) this.resolve();
      }
    };
    this.canvas.addEventListener('click', this.clickHandler);
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

    setTimeout(() => {
      if (this.active?.type === 'voice-gate') {
        this.updateQteLabel('speak or press space');
      }
    }, 1500);

    // Click fallback
    this.gateButton = this.qteSprite;
    this.clickHandler = (e: MouseEvent) => {
      this.pointer.x = (e.clientX / this.canvas.clientWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / this.canvas.clientHeight) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      if (this.qteSprite) {
        const hits = this.raycaster.intersectObject(this.qteSprite);
        if (hits.length > 0) this.resolve();
      }
    };
    this.canvas.addEventListener('click', this.clickHandler);
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
        setTimeout(() => this.resolve(), 2000);
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
    this.updateQteLabel('hum or hold space');
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
      setTimeout(() => this.resolve(), 500);
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

    setTimeout(() => {
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
      setTimeout(() => this.resolve(), 1500);
      this.affirmState.detected = false;
      this.affirmState.waitStart = Infinity;
    }

    if (elapsed > (this.active?.duration ?? 8) + 3) {
      this.resolve();
    }
  }
}
