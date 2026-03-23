/**
 * Render pipeline — extracted from main.ts.
 *
 * Owns the Three.js render calls, shader uniform updates, and
 * feedback warp compositing. Main.ts provides frame state,
 * this module pushes it to the GPU.
 *
 * Two modes:
 *   renderBackground() — selector screen (low intensity, no audio)
 *   renderSession()    — active session (full intensity, audio-reactive)
 */

import * as THREE from 'three';
import type { FeedbackWarp } from './feedback';
import type { GpuParticles } from './gpu-particles';
import type { Presence } from './presence';
import type { BreathStage } from './breath';
import type { HpynoSettings } from './settings';
import type { SessionTheme } from './session';
import type { AudioBands } from './audio-analyzer';

// Reuse temp objects (avoid GC per frame)
const _tmpVec2 = new THREE.Vector2();
const _tmpVec3 = new THREE.Vector3();

function breathStageToFloat(stage: BreathStage): number {
  switch (stage) {
    case 'inhale': return 0;
    case 'hold-in': return 1;
    case 'exhale': return 2;
    case 'hold-out': return 3;
  }
}

/** Per-frame state passed from main.ts to the renderer */
export interface FrameState {
  time: number;
  dt: number;
  settings: Readonly<HpynoSettings>;

  // Breath
  breathPhase: number;
  breathValue: number;
  breathStage: BreathStage;

  // Tunnel
  intensity: number;
  spiralAngle: number;
  spiralSpeed: number;
  mouseX: number;
  mouseY: number;

  // Audio (null during background)
  audioBands: AudioBands | null;
  voiceEnergy: number;
  micBoost: number;

  // Interaction shader state
  breathSyncActive: number;
  breathSyncFill: number;
  breathSyncProgress: number;

  // Transition
  fadeAmount: number;
  intensityMult: number;

  // Theme color lerp targets (background mode only)
  targetColors?: {
    c1: [number, number, number];
    c2: [number, number, number];
    c3: [number, number, number];
    c4: [number, number, number];
    particle: [number, number, number];
    shape: number;
  };
}

export interface RenderPipelineDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  overlayScene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tunnelUniforms: Record<string, { value: any }>;
  feedback: FeedbackWarp;
  compositeQuad: THREE.Mesh;
  compositeScene: THREE.Scene;
  compositeCamera: THREE.OrthographicCamera;
  fadeOverlay: THREE.Mesh;
  gpuParticles: GpuParticles;
  presence: Presence;
}

export class RenderPipeline {
  private deps: RenderPipelineDeps;

  constructor(deps: RenderPipelineDeps) {
    this.deps = deps;
  }

  /** Update tunnel shader uniforms from frame state */
  private updateUniforms(frame: FrameState): void {
    const u = this.deps.tunnelUniforms;
    const s = frame.settings;

    u.uTime.value = frame.time;
    u.uIntensity.value = frame.intensity * frame.intensityMult;
    u.uMouse.value.lerp(_tmpVec2.set(frame.mouseX, frame.mouseY), 0.02);
    u.uBreathePhase.value = frame.breathPhase;
    u.uBreathValue.value = frame.breathValue;
    u.uBreathStage.value = breathStageToFloat(frame.breathStage);
    u.uSpiralSpeed.value = frame.spiralSpeed * s.spiralSpeedMult;
    u.uSpiralAngle.value = frame.spiralAngle;
    u.uTunnelSpeed.value = s.tunnelSpeed;
    u.uTunnelWidth.value = s.tunnelWidth;
    u.uBreathExpansion.value = s.breathExpansion;

    if (frame.audioBands) {
      u.uAudioEnergy.value = frame.audioBands.energy;
      u.uAudioBass.value = frame.audioBands.bass;
      u.uAudioMid.value = frame.audioBands.mid;
      u.uAudioHigh.value = frame.audioBands.high;
    }

    u.uVoiceEnergy.value = frame.voiceEnergy;
    u.uIntensity.value += frame.micBoost;

    // Interaction uniforms
    u.uBreathSyncActive.value = frame.breathSyncActive;
    u.uBreathSyncFill.value = frame.breathSyncFill;
    u.uBreathSyncProgress.value = frame.breathSyncProgress;
  }

  /** Update camera from settings */
  private updateCamera(frame: FrameState, sway = 0): void {
    const { camera } = this.deps;
    const s = frame.settings;

    camera.position.z = s.cameraZ;
    if (camera.fov !== s.cameraFOV) {
      camera.fov = s.cameraFOV;
      camera.updateProjectionMatrix();
    }

    if (sway > 0) {
      camera.position.x = Math.sin(frame.time * 0.1) * 0.02 * sway * s.cameraSway;
      camera.position.y = Math.cos(frame.time * 0.13) * 0.02 * sway * s.cameraSway;
      camera.lookAt(0, 0, 0);
    }
  }

  /** Lerp tunnel colors toward targets (selector theme preview) */
  private lerpColors(targets: NonNullable<FrameState['targetColors']>): void {
    const u = this.deps.tunnelUniforms;
    const speed = 0.03;
    u.uColor1.value.lerp(_tmpVec3.set(...targets.c1), speed);
    u.uColor2.value.lerp(_tmpVec3.set(...targets.c2), speed);
    u.uColor3.value.lerp(_tmpVec3.set(...targets.c3), speed);
    u.uColor4.value.lerp(_tmpVec3.set(...targets.c4), speed);
    u.uTunnelShape.value += (targets.shape - (u.uTunnelShape.value as number)) * speed;
    this.deps.gpuParticles.setColor(targets.particle[0], targets.particle[1], targets.particle[2]);
  }

  /** Update fade overlay */
  private updateFade(fadeAmount: number): void {
    const mat = this.deps.fadeOverlay.material as THREE.MeshBasicMaterial;
    mat.opacity = fadeAmount;
    this.deps.fadeOverlay.visible = fadeAmount > 0.001;
  }

  /** Execute the render passes: scene → feedback → composite → overlay */
  private renderPasses(frame: FrameState): void {
    const { renderer, scene, camera, feedback, compositeQuad, compositeScene, compositeCamera, overlayScene } = this.deps;
    const renderIntensity = frame.intensity * frame.intensityMult;

    // Pass 1: render scene (tunnel + particles) to offscreen target
    renderer.setRenderTarget(feedback.tunnelTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    // Pass 2: feedback composite (or passthrough if disabled)
    feedback.setParams({
      zoom: 0.004 + renderIntensity * 0.006,
      rotation: 0.0005 + renderIntensity * 0.001,
    });
    const compositeTex = feedback.render(renderer, frame.time, renderIntensity);
    (compositeQuad.material as THREE.MeshBasicMaterial).map = compositeTex;
    renderer.render(compositeScene, compositeCamera);

    // Pass 3: overlay (text, UI sprites — sharp, no feedback blur)
    renderer.autoClear = false;
    renderer.render(overlayScene, camera);
    renderer.autoClear = true;
  }

  /** Apply session theme colors to uniforms + subsystems */
  applyTheme(theme: SessionTheme): void {
    const u = this.deps.tunnelUniforms;
    u.uColor1.value.set(...theme.primaryColor);
    u.uColor2.value.set(...theme.secondaryColor);
    u.uColor3.value.set(...theme.accentColor);
    u.uColor4.value.set(...theme.bgColor);
    u.uTunnelShape.value = theme.tunnelShape ?? 0;
    this.deps.gpuParticles.setColor(...theme.particleColor);
    this.deps.presence.setColors(theme.accentColor);
  }

  /** Update presence and sync its position to the tunnel shader */
  private updatePresence(frame: FrameState, isSession: boolean): void {
    const { presence, tunnelUniforms } = this.deps;
    if (isSession) {
      presence.update(
        frame.time, frame.breathValue, frame.voiceEnergy,
        frame.audioBands?.energy ?? 0, frame.audioBands?.bass ?? 0,
        frame.intensity,
      );
    } else {
      presence.updateIdle(frame.time, frame.breathValue);
    }
    tunnelUniforms.uPresencePos.value.copy(presence.mesh.position);
  }

  /** Render the selector/background screen */
  renderBackground(frame: FrameState): void {
    this.updateUniforms(frame);
    this.updateCamera(frame);
    if (frame.targetColors) this.lerpColors(frame.targetColors);
    this.deps.gpuParticles.update(frame.time, 0.1, frame.settings.particleOpacity, frame.settings.particleSize);
    this.updatePresence(frame, false);
    this.updateFade(frame.fadeAmount);
    this.renderPasses(frame);
  }

  /** Render an active session frame */
  renderSession(frame: FrameState): void {
    this.updateUniforms(frame);
    this.updateCamera(frame, frame.intensity);
    this.deps.gpuParticles.update(frame.time, frame.intensity, frame.settings.particleOpacity, frame.settings.particleSize);
    this.updatePresence(frame, true);
    this.updateFade(frame.fadeAmount);
    this.renderPasses(frame);
  }
}
