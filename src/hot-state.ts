/**
 * HMR-persistent state for the 3D experience.
 *
 * Objects stored here survive Vite hot reloads so the WebGL context,
 * scene graph, and runtime state don't get torn down and rebuilt on
 * every file save.
 *
 * Usage: import { hotState } from './hot-state';
 * Then read/write properties as needed. On first load everything is
 * undefined; on subsequent HMR updates the previous values persist.
 */

import type * as THREE from 'three';
import type { AudioEngine } from './audio';
import type { Text3D } from './text3d';
import type { BreathController } from './breath';
import type { NarrationEngine } from './narration';
import type { MicrophoneEngine } from './microphone';
import type { AmbientEngine } from './ambient';
// StageManager removed — replaced by Timeline
import type { InteractionManager } from './interactions';
import type { DevMode } from './devmode';
import type { SessionSelector } from './selector';
import type { SettingsManager } from './settings';
import type { SessionConfig } from './session';
import type { FeedbackWarp } from './feedback';
import type { EventBus } from './events';
import type { StateMachine } from './state-machine';
import type { InputController } from './input';
import type { GpuParticles } from './gpu-particles';
import type { Favorites } from './favorites';
import type { Entitlements } from './entitlements';
import type { UpgradePrompt } from './upgrade-prompt';

/** Auth state exposed by AuthManager (created by auth.ts when Supabase is configured) */
export interface AuthState {
  user: { id: string; email?: string; name?: string; avatar?: string } | null;
  isAuthenticated: boolean;
  isAnonymous: boolean;
  loading: boolean;
}

/** Minimal interface the auth UI binds to — implemented by AuthManager */
export interface AuthManagerLike {
  getState(): AuthState;
  onChange(listener: (state: AuthState) => void): () => void;
  signInWithGoogle(): void;
  signInAnonymously(): void;
  signOut(): void;
  linkGoogle(): void;
}

export interface HotState {
  // Auth
  authManager?: AuthManagerLike;

  // Event system
  eventBus?: EventBus;
  stateMachine?: StateMachine;
  inputController?: InputController;

  // Core Three.js — these are expensive to recreate
  renderer?: THREE.WebGLRenderer;
  scene?: THREE.Scene;
  camera?: THREE.PerspectiveCamera;

  // Shader material (holds uniform references)
  tunnelMaterial?: THREE.ShaderMaterial;
  tunnelPlane?: THREE.Mesh;

  // Subsystems
  audio?: AudioEngine;
  ambient?: AmbientEngine;
  presence?: import('./presence').Presence;
  text3d?: Text3D;
  breath?: BreathController;
  narration?: NarrationEngine;
  mic?: MicrophoneEngine;
  // stageManager removed — replaced by Timeline
  interactions?: InteractionManager;
  devMode?: DevMode;
  selector?: SessionSelector;
  settings?: SettingsManager;
  entitlements?: Entitlements;
  upgradePrompt?: UpgradePrompt;

  // Visual layers
  gpuParticles?: GpuParticles;
  feedback?: FeedbackWarp;
  compositeQuad?: THREE.Mesh;
  overlayScene?: THREE.Scene;
  fadeOverlay?: THREE.Mesh;

  // Data modules
  favorites?: Favorites;

  // Runtime state
  isRunning?: boolean;
  activeSession?: SessionConfig | null;
  spiralAngle?: number;
  lastAnimTime?: number;
  intensityOverride?: number | null;
  shaderIntensityScale?: number;
  animFrameId?: number;
  bgAnimFrameId?: number;

  // To track cleanup
  cleanupFns?: Array<() => void>;
}

// Persist across HMR via a global that Vite won't touch
const KEY = '__HPYNO_HOT_STATE__';
const g = globalThis as unknown as Record<string, HotState>;
if (!g[KEY]) g[KEY] = {};

export const hotState: HotState = g[KEY];
