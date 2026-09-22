/**
 * Engine — composes renderer, world, audio graph, and quality manager
 * into one frame loop. The app supplies inputs through `setInputSource`.
 */

import { WorldRenderer } from './render/renderer';
import { QualityManager, type QualityLevel } from './render/quality';
import { World } from './world/world';
import { AudioGraph } from './audio/graph';
import { BreathClock } from './world/breath';
import { EMPTY_INPUTS, type WorldInputs } from './world/types';

export type FrameMode = 'active' | 'idle' | 'off';

export type InputSource = (inputs: WorldInputs) => void;

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WorldRenderer;
  readonly world: World;
  readonly audio = new AudioGraph();
  readonly quality: QualityManager;
  readonly breath = new BreathClock();
  readonly inputs: WorldInputs = structuredClone(EMPTY_INPUTS);

  private source: InputSource | null = null;
  private raf = 0;
  private running = false;
  private last = 0;
  private time = 0;
  private mode: FrameMode = 'active';
  private idleAccum = 0;
  private ro: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WorldRenderer(canvas);
    this.world = new World(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.quality = new QualityManager();
    this.quality.onChange((_l, p) => this.applyQuality(p.pixelRatio, p.feedback, p.particleBudget));
    this.applyQuality(this.quality.profile.pixelRatio, this.quality.profile.feedback, this.quality.profile.particleBudget);

    window.addEventListener('pointermove', this.onPointer, { passive: true });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
    this.resize();
  }

  /** Time in seconds the world has been animating (pauses with frame mode 'off'). */
  get worldTime(): number { return this.time; }

  setInputSource(fn: InputSource | null): void { this.source = fn; }

  /** 'active' = every rAF; 'idle' = ~8 fps; 'off' = no rendering. */
  setFrameMode(mode: FrameMode): void { this.mode = mode; }

  forceQuality(level: QualityLevel | null): void { this.quality.force(level); }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private onPointer = (e: PointerEvent): void => {
    this.inputs.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.inputs.pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
  };

  private applyQuality(pixelRatio: number, feedback: boolean, budget: number): void {
    this.renderer.feedbackEnabled = feedback;
    this.world.particles.setBudget(budget);
    this.renderer.setSize(this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight, pixelRatio);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, this.quality.profile.pixelRatio);
    this.world.resize(w, h);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.mode === 'off') { this.last = now; return; }

    const rawDt = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(rawDt, 0.1);

    if (this.mode === 'idle') {
      this.idleAccum += dt;
      if (this.idleAccum < 1 / 8) return;
    }
    const stepDt = this.mode === 'idle' ? this.idleAccum : dt;
    this.idleAccum = 0;

    if (this.mode === 'active') this.quality.sample(rawDt);

    this.time += stepDt;
    const inp = this.inputs;
    inp.time = this.time;
    inp.dt = stepDt;

    // Defaults the source may override
    const b = this.breath.update(stepDt);
    inp.breath.value = b.value; inp.breath.phase = b.phase; inp.breath.stage = b.stage;
    const an = this.audio.analyzer;
    inp.audio = an ? an.update() : null;
    const va = this.audio.voiceAnalyzer;
    inp.voice = va ? va.update().voice : 0;

    this.source?.(inp);

    this.world.update(inp);
    this.renderer.render(this.world, this.time);
  };

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    window.removeEventListener('pointermove', this.onPointer);
    this.world.dispose();
    this.renderer.dispose();
    this.audio.dispose();
  }
}
