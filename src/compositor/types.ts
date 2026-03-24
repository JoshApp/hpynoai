/**
 * Compositor type definitions — Layer, Actor, Preset, Config, WorldInputs.
 *
 * These are the interfaces that the compositor and all layers/actors implement.
 * The compositor doesn't know what specific layers or actors exist — it just
 * calls update() and render() on whatever's registered.
 */

import type * as THREE from 'three';
import type { BreathStage } from '../breath';
import type { SessionConfig } from '../session';
import type { TimelineState } from '../timeline';
import type { TextStyle, WordTiming } from '../text3d';
import type { InteractionShaderState } from '../interactions';

// ── Shared reactive signals (built once per tick, read by all) ──

export interface AudioBands {
  energy: number;
  bass: number;
  mid: number;
  high: number;
}

export interface WorldInputs {
  timeline: TimelineState | null;
  audioBands: AudioBands | null;
  voiceEnergy: number;
  breathPhase: number;
  breathValue: number;
  breathStage: BreathStage;
  micActive: boolean;
  micBoost: number;
  interactionShader: InteractionShaderState;
  renderTime: number;      // accumulated render time (immune to tab jumps)
  dt: number;
}

// ── Render context (passed during render, not tick) ──

export interface RenderContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  overlayScene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  compositeScene: THREE.Scene;
  compositeCamera: THREE.OrthographicCamera;
  time: number;
  dt: number;
}

// ── Layer preset values ──

export interface TunnelPreset {
  intensity: number;
  spiralSpeed: number;
  audioReactivity: number;
  colors?: {
    c1: [number, number, number];
    c2: [number, number, number];
    c3: [number, number, number];
    c4: [number, number, number];
  };
  tunnelShape?: number;
  tunnelSpeed?: number;
  tunnelWidth?: number;
  breathExpansion?: number;
}

export interface FeedbackPreset {
  strength: number;    // 0-1, maps to zoom/rotation/decay
}

export interface CameraPreset {
  sway: number;
  fov?: number;
}

export interface ParticlesPreset {
  visible: boolean;
  intensity: number;
}

export interface FadePreset {
  opacity: number;
}

export interface Preset {
  tunnel?: Partial<TunnelPreset>;
  feedback?: Partial<FeedbackPreset>;
  camera?: Partial<CameraPreset>;
  particles?: Partial<ParticlesPreset>;
  fade?: Partial<FadePreset>;
}

// ── Actor directives ──

export type PresenceDirective =
  | { role: 'menu-guide' }
  | { role: 'breathing-companion' }
  | { role: 'narrator' }
  | { role: 'idle' }
  | { role: 'hidden' };

export type TextDirective =
  | { mode: 'cue'; text: string; depth?: number }
  | { mode: 'prompt'; text: string }
  | { mode: 'narration-tts'; text: string }
  | { mode: 'focus'; text: string; words?: Array<{ word: string; start: number; end: number }>; audioRef?: HTMLAudioElement | null; lineStart?: number }
  | { mode: 'clear' };

export type NarrationDirective =
  | { action: 'play-stage'; stageName: string; offset: number }
  | { action: 'speak-tts'; text: string }
  | { action: 'stop' };

export type BreathDirective =
  | { action: 'drive'; value: number; stage: BreathStage }
  | { action: 'apply-stage'; stage: import('../session').SessionStage }
  | { action: 'release' };

export type AudioClipDirective =
  | { clip: string }     // desired clip name
  | { clip: null };      // stop

export type ActorDirective =
  | { type: 'presence'; directive: PresenceDirective }
  | { type: 'text'; directive: TextDirective }
  | { type: 'narration'; directive: NarrationDirective }
  | { type: 'breath'; directive: BreathDirective }
  | { type: 'audio-clip'; directive: AudioClipDirective };

// ── Configuration (preset + actor directives) ──

export interface Config {
  preset: Preset;
  actors: ActorDirective[];
}

// ── Layer interface ──

export interface Layer {
  name: string;
  renderOrder: number;
  applyPreset(preset: Preset, transitionSpeed: number): void;
  update(inputs: WorldInputs, dt: number): void;
  render?(ctx: RenderContext): void;
  onSessionStart?(session: SessionConfig): void;
  onSessionEnd?(): void;
  dispose?(): void;
}

// ── Actor interface ──

export interface Actor {
  name: string;
  active: boolean;
  renderOrder: number;
  setDirective(directive: ActorDirective): void;
  activate(directive?: ActorDirective): void;
  deactivate(): void;
  update(inputs: WorldInputs, dt: number): void;
  render?(ctx: RenderContext): void;
  onSessionStart?(session: SessionConfig): void;
  onSessionEnd?(): void;
  dispose?(): void;
}

// ── Easing functions ──

export type EasingFn = (t: number) => number;

export const easings = {
  linear: (t: number) => t,
  easeIn: (t: number) => t * t,
  easeOut: (t: number) => 1 - (1 - t) * (1 - t),
  easeInOut: (t: number) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,
  smoothstep: (t: number) => t * t * (3 - 2 * t),
};
