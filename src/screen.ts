/**
 * Screen interface — each screen is a self-contained UI state.
 *
 * Screens own their 3D/DOM elements, subscribe to bus events on enter,
 * and clean up everything on exit. The persistent world (tunnel, presence,
 * audio compositor) keeps running underneath — screens just configure it.
 */

import type * as THREE from 'three';
import type { EventBus } from './events';
import type { SettingsManager } from './settings';
import type { Presence } from './presence';
import type { NarrationEngine } from './narration';
import type { AudioEngine } from './audio';
import type { BreathController } from './breath';
import type { Timeline } from './timeline';
import type { InteractionManager } from './interactions';
import type { DevMode } from './devmode';
import type { StateMachine } from './state-machine';
import type { Compositor } from './compositor';
import type { AudioCompositor, AudioPreset } from './audio-compositor';
import type { TunnelLayer } from './compositor/layers/tunnel';
import type { ParticlesLayer } from './compositor/layers/particles';
import type { FeedbackLayer } from './compositor/layers/feedback';
import type { CameraLayer } from './compositor/layers/camera';
import type { TextActor } from './compositor/actors/text';
import type { AudioClipActor } from './compositor/actors/audio-clip';
import type { NarrationActor } from './compositor/actors/narration';
import type { BreathActor } from './compositor/actors/breath';
import type { PresenceActor } from './compositor/actors/presence';
import type { PlaybackControls } from './playback-controls';
import type { Timebar } from './timebar';
import type { HUD } from './hud';
import type { WorldInputs, Config } from './compositor/types';
import type { TransitionManager } from './transition';

/**
 * ScreenContext — bag of references to persistent subsystems.
 * Screens don't own these, they use them. Built once by main.ts.
 */
export interface ScreenContext {
  // Three.js
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  overlayScene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  compositeScene: THREE.Scene;
  compositeCamera: THREE.OrthographicCamera;
  canvas: HTMLCanvasElement;

  // Core systems
  bus: EventBus;
  settings: SettingsManager;
  machine: StateMachine;
  transition: TransitionManager;

  // Visual compositor + layers
  compositor: Compositor;
  tunnelLayer: TunnelLayer;
  feedbackLayer: FeedbackLayer;
  cameraLayer: CameraLayer;
  particlesLayer: ParticlesLayer;

  // Actors
  textActor: TextActor;
  audioClipActor: AudioClipActor;
  narrationActor: NarrationActor;
  breathActor: BreathActor;
  presenceActor: PresenceActor;

  // Audio
  audio: AudioEngine;
  audioCompositor: AudioCompositor;
  narration: NarrationEngine;
  breath: BreathController;

  // Visual
  presence: Presence;

  // Timeline
  timeline: Timeline;

  // Interactions
  interactions: InteractionManager;

  // UI
  hud: HUD;
  playbackControls: PlaybackControls;
  timebar: Timebar;
  devMode: DevMode;

  // Screen manager reference (for navigation from within screens)
  screenManager: ScreenManager;
}

/**
 * Screen — a self-contained UI state in the app.
 *
 * Lifecycle:
 *   enter() → tick()/render() each frame → exit()
 *
 * Screens subscribe to bus events in enter() and unsubscribe in exit().
 * They create 3D elements in enter() and dispose them in exit().
 */
export interface Screen {
  readonly name: string;

  /** Called when this screen becomes active. Set up elements, subscribe events. */
  enter(ctx: ScreenContext, from: string | null): void;

  /** Called when this screen is being removed. Dispose everything. */
  exit(): void;

  /** Per-tick update (60Hz setInterval, runs even when tab hidden). Optional. */
  tick?(inputs: WorldInputs, dt: number): void;

  /** Per-frame render (rAF, only when visible). Optional. */
  render?(time: number, dt: number): void;

  /** Audio preset to apply on enter. Optional. */
  getAudioPreset?(): Partial<AudioPreset> | null;
}

// Forward reference — resolved by screen-manager.ts
import type { ScreenManager } from './screen-manager';
