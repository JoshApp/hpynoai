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
import type { ParticleField } from './particles';
import type { Text3D } from './text3d';
import type { BreathController } from './breath';
import type { NarrationEngine } from './narration';
import type { MicrophoneEngine } from './microphone';
import type { AmbientEngine } from './ambient';
import type { StageManager } from './stages';
import type { InteractionManager } from './interactions';
import type { DevMode } from './devmode';
import type { SessionSelector } from './selector';
import type { SettingsManager } from './settings';
import type { SessionConfig } from './session';
import type { FeedbackWarp } from './feedback';
import type { FogLayers } from './fog-layers';
import type { DepthParticles } from './depth-particles';
import type { GpuParticles } from './gpu-particles';

export interface HotState {
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
  particles?: ParticleField;
  text3d?: Text3D;
  breath?: BreathController;
  narration?: NarrationEngine;
  mic?: MicrophoneEngine;
  stageManager?: StageManager;
  interactions?: InteractionManager;
  devMode?: DevMode;
  selector?: SessionSelector;
  settings?: SettingsManager;

  // Visual layers
  depthParticles?: DepthParticles;
  gpuParticles?: GpuParticles;
  fogLayers?: FogLayers;
  feedback?: FeedbackWarp;
  compositeQuad?: THREE.Mesh;
  overlayScene?: THREE.Scene;
  fadeOverlay?: THREE.Mesh;

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
