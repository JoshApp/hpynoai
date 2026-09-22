/**
 * World types — the contract between the engine's persistent 3D world and
 * whoever drives it (the player, the app shell, the dev harness).
 *
 * The world knows nothing about sessions, cues, or UI. It receives a
 * WorldInputs bag every frame and a Preset whenever the driver wants the
 * look to change.
 */

export type Vec3 = [number, number, number];

export type BreathStage = 'inhale' | 'hold-in' | 'exhale' | 'hold-out';

export interface AudioBands {
  energy: number;
  bass: number;
  mid: number;
  high: number;
}

export interface BreathInputs {
  /** 0 = fully exhaled, 1 = fully inhaled */
  value: number;
  /** Cycle phase in radians (0..2π) for shader oscillators */
  phase: number;
  stage: BreathStage;
}

export interface WorldInputs {
  /** Accumulated render time in seconds (immune to tab jumps) */
  time: number;
  dt: number;
  audio: AudioBands | null;
  /** Narrator voice energy 0..1 (real analyser, not synthesized) */
  voice: number;
  breath: BreathInputs;
  /** Session depth 0..1 — drives shader intensity via preset, exposed here for entities */
  intensity: number;
  /** Pointer in NDC (-1..1), for parallax */
  pointer: { x: number; y: number };
  /** Breath-band overlay in the tunnel (guided breathing moments) */
  breathBand: { active: number; fill: number; progress: number };
}

export const EMPTY_INPUTS: WorldInputs = {
  time: 0, dt: 0, audio: null, voice: 0,
  breath: { value: 0.5, phase: 0, stage: 'inhale' },
  intensity: 0.1,
  pointer: { x: 0, y: 0 },
  breathBand: { active: 0, fill: 0, progress: 0 },
};

// ── Layer presets ──

export interface TunnelColors { c1: Vec3; c2: Vec3; c3: Vec3; c4: Vec3 }

export interface TunnelPreset {
  intensity: number;
  spiralSpeed: number;
  audioReactivity: number;
  colors: TunnelColors;
  /** 0 = geometric, 1 = organic */
  shape: number;
  speed: number;
  width: number;
  breathExpansion: number;
}

export interface FeedbackPreset { strength: number }
export interface CameraPreset { sway: number; fov: number }
export interface ParticlesPreset { visible: boolean; intensity: number; color: Vec3 }
export interface FadePreset { opacity: number }

export interface Preset {
  tunnel?: Partial<TunnelPreset>;
  feedback?: Partial<FeedbackPreset>;
  camera?: Partial<CameraPreset>;
  particles?: Partial<ParticlesPreset>;
  fade?: Partial<FadePreset>;
}

export interface Layer {
  readonly name: string;
  applyPreset(preset: Preset, speed: number): void;
  update(inputs: WorldInputs, dt: number): void;
  dispose?(): void;
}

export type EasingFn = (t: number) => number;

export const easings = {
  linear: (t: number): number => t,
  easeIn: (t: number): number => t * t,
  easeOut: (t: number): number => 1 - (1 - t) * (1 - t),
  easeInOut: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  smoothstep: (t: number): number => t * t * (3 - 2 * t),
} as const;
