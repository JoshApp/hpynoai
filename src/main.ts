import * as THREE from 'three';
import { AudioEngine } from './audio';
import { StageManager } from './stages';
import { ParticleField } from './particles';
import { DevMode } from './devmode';
import { InteractionManager } from './interactions';
import { SessionSelector } from './selector';
import { sessions } from './sessions/index';
import { MicrophoneEngine } from './microphone';
import { NarrationEngine } from './narration';
import type { AudioBands } from './audio-analyzer';
import type { SessionConfig, SessionStage, Interaction } from './session';
import { Text3D } from './text3d';
import { SettingsManager } from './settings';
import { runAutoCalibration, autoCalibrationFrameHook } from './calibration-auto';
import { GuidedCalibration } from './calibration-guided';
import { BreathController, type BreathStage } from './breath';
import { AmbientEngine } from './ambient';
import { hotState } from './hot-state';
import { appState, setPhase, setSessionInfo } from './app-state';
import { acquireWakeLock, releaseWakeLock, registerMediaSession, clearMediaSession, startSilentAudioKeepAlive, stopSilentAudioKeepAlive } from './wakelock';
import { FeedbackWarp } from './feedback';
import { FogLayers } from './fog-layers';
import { DepthParticles } from './depth-particles';
import { GpuParticles } from './gpu-particles';
import { TransitionManager } from './transition';
import tunnelVert from './shaders/tunnel.vert';
import tunnelFrag from './shaders/tunnel.frag';

function breathStageToFloat(stage: BreathStage): number {
  switch (stage) {
    case 'inhale': return 0;
    case 'hold-in': return 1;
    case 'exhale': return 2;
    case 'hold-out': return 3;
  }
}

// ── Reusable temp objects for per-frame lerps (avoid GC pressure) ──
const _tmpVec2 = new THREE.Vector2();
const _tmpVec3 = new THREE.Vector3();
const _tmpColor = new THREE.Color();

// ══════════════════════════════════════════════════════════════════════
// HMR CLEANUP — cancel old frames and remove old listeners
// ══════════════════════════════════════════════════════════════════════
if (hotState.animFrameId) cancelAnimationFrame(hotState.animFrameId);
if (hotState.bgAnimFrameId) cancelAnimationFrame(hotState.bgAnimFrameId);
hotState.animFrameId = undefined;
hotState.bgAnimFrameId = undefined;
if (hotState.cleanupFns) {
  for (const fn of hotState.cleanupFns) fn();
}
hotState.cleanupFns = [];

function onCleanup(fn: () => void): void {
  hotState.cleanupFns!.push(fn);
}

const isHMR = !!hotState.renderer;

// ══════════════════════════════════════════════════════════════════════
// DOM ELEMENTS
// ══════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const breathGuide = document.getElementById('breath-guide')!;
const breathCircle = document.getElementById('breath-circle')!;

// ══════════════════════════════════════════════════════════════════════
// SUBSYSTEMS — reuse across HMR, create only on first load
// ══════════════════════════════════════════════════════════════════════
const settings = hotState.settings ?? new SettingsManager();
hotState.settings = settings;

const mouse = { x: 0, y: 0 };

/**
 * Session lifecycle guard — monotonic counter incremented on every state transition.
 * Async callbacks capture the epoch at start and bail if it changed while awaiting.
 * This eliminates race conditions from stale callbacks firing after transitions.
 */
let sessionEpoch = 0;

let isRunning = hotState.isRunning ?? false;
let intensityOverride: number | null = hotState.intensityOverride ?? null;
let shaderIntensityScale = hotState.shaderIntensityScale ?? 1.0;
let spiralAngle = hotState.spiralAngle ?? 0;
let lastAnimTime = hotState.lastAnimTime ?? 0;
let activeSession: SessionConfig | null = hotState.activeSession ?? null;

// ── Three.js core ──
const renderer = hotState.renderer ?? (() => {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true });
  r.setSize(window.innerWidth, window.innerHeight);
  r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  return r;
})();
hotState.renderer = renderer;

const scene = hotState.scene ?? new THREE.Scene();
hotState.scene = scene;

const camera = hotState.camera ?? (() => {
  const c = new THREE.PerspectiveCamera(settings.current.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
  c.position.z = settings.current.cameraZ;
  return c;
})();
hotState.camera = camera;

// ── Tunnel shader ──
let tunnelMaterial: THREE.ShaderMaterial;
let tunnelPlane: THREE.Mesh;

if (hotState.tunnelMaterial) {
  tunnelMaterial = hotState.tunnelMaterial;
  tunnelPlane = hotState.tunnelPlane!;
  if (tunnelMaterial.vertexShader !== tunnelVert || tunnelMaterial.fragmentShader !== tunnelFrag) {
    tunnelMaterial.vertexShader = tunnelVert;
    tunnelMaterial.fragmentShader = tunnelFrag;
    tunnelMaterial.needsUpdate = true;
    console.log('[HMR] Shader updated');
  }
} else {
  tunnelMaterial = new THREE.ShaderMaterial({
    vertexShader: tunnelVert,
    fragmentShader: tunnelFrag,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uBreathePhase: { value: 0 },
      uBreathValue: { value: 0 },
      uBreathStage: { value: 0 },
      uSpiralSpeed: { value: 1.0 },
      uSpiralAngle: { value: 0 },
      uTunnelSpeed: { value: 1.0 },
      uTunnelWidth: { value: 1.0 },
      uBreathExpansion: { value: 1.0 },
      uTunnelShape: { value: 0.0 },
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uColor1: { value: new THREE.Vector3(0.45, 0.1, 0.55) },
      uColor2: { value: new THREE.Vector3(0.7, 0.3, 0.9) },
      uColor3: { value: new THREE.Vector3(0.6, 0.3, 0.8) },
      uColor4: { value: new THREE.Vector3(0.15, 0.02, 0.25) },
      uAudioEnergy: { value: 0 },
      uAudioBass: { value: 0 },
      uAudioMid: { value: 0 },
      uAudioHigh: { value: 0 },
      uVoiceEnergy: { value: 0 },
      uBreathSyncActive: { value: 0 },
      uBreathSyncFill: { value: 0 },
      uBreathSyncProgress: { value: 0 },
    },
  });
  tunnelPlane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), tunnelMaterial);
  scene.add(tunnelPlane);
}
hotState.tunnelMaterial = tunnelMaterial;
hotState.tunnelPlane = tunnelPlane;
const tunnelUniforms = tunnelMaterial.uniforms;

// ── Scene objects ──
const particles = hotState.particles ?? (() => {
  const p = new ParticleField(200);
  scene.add(p.mesh);
  return p;
})();
hotState.particles = particles;

// ── Depth particles (3-layer parallax) ──
const depthParticles = hotState.depthParticles ?? (() => {
  const dp = new DepthParticles();
  scene.add(dp.group);
  return dp;
})();
hotState.depthParticles = depthParticles;

// ── GPU particles (zero CPU cost — all animation in vertex shader) ──
const gpuParticles = hotState.gpuParticles ?? (() => {
  const gp = new GpuParticles(250);
  scene.add(gp.mesh);
  return gp;
})();
hotState.gpuParticles = gpuParticles;

// ── Fog layers (volumetric atmosphere — now also baked into tunnel shader) ──
const fogLayers = hotState.fogLayers ?? (() => {
  const fl = new FogLayers();
  fl.addTo(scene);
  return fl;
})();
hotState.fogLayers = fogLayers;

// ── Feedback warp (Milkdrop-style frame accumulation) ──
const feedback = hotState.feedback ?? new FeedbackWarp(
  window.innerWidth, window.innerHeight,
);
hotState.feedback = feedback;

// Fullscreen quad for displaying feedback output
const compositeQuad = hotState.compositeQuad ?? (() => {
  const mat = new THREE.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  return mesh;
})();
hotState.compositeQuad = compositeQuad;

const compositeScene = new THREE.Scene();
compositeScene.add(compositeQuad);
const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ── Overlay scene — UI elements rendered AFTER feedback (no blur) ──
const overlayScene = hotState.overlayScene ?? new THREE.Scene();
hotState.overlayScene = overlayScene;

const text3d = hotState.text3d ?? (() => {
  const t = new Text3D();
  overlayScene.add(t.mesh);
  return t;
})();
hotState.text3d = text3d;

// ── Transition manager ──
const transition = new TransitionManager();

// ── Fade overlay — fullscreen black plane in front of everything ──
const fadeOverlay = hotState.fadeOverlay ?? (() => {
  const geo = new THREE.PlaneGeometry(20, 20);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = 0.5; // in front of everything in overlay scene
  mesh.renderOrder = 9999;
  overlayScene.add(mesh);
  return mesh;
})();
hotState.fadeOverlay = fadeOverlay;

// ── Audio/mic ──
const audio = hotState.audio ?? new AudioEngine();
hotState.audio = audio;

const ambient = hotState.ambient ?? new AmbientEngine();
hotState.ambient = ambient;

const mic = hotState.mic ?? new MicrophoneEngine();
hotState.mic = mic;

// ── Breath ──
const breath = hotState.breath ?? (() => {
  const b = new BreathController();
  b.setSimpleCycle(10);
  return b;
})();
hotState.breath = breath;

// ── Narration ──
const narration = hotState.narration ?? new NarrationEngine({
  voiceEnabled: settings.current.ttsEnabled,
  rate: 0.85,
  pitch: 0.9,
  volume: settings.current.narrationVolume,
});
hotState.narration = narration;
narration.setTextHandler((text, words, audioStartTime) => showText(text, words, audioStartTime));

// ══════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════
function showText(text: string, words?: Array<{ word: string; start: number; end: number }>, audioStartTime?: number): void {
  if (activeSession) {
    text3d.setColors(activeSession.theme.textColor, activeSession.theme.textGlow);
  }
  const audioRef = narration.isPlayingStage ? narration.stageAudioElement : null;
  text3d.show(text, 8, words, audioRef, audioStartTime);
}

function applyTheme(session: SessionConfig): void {
  const { theme } = session;
  tunnelUniforms.uColor1.value.set(...theme.primaryColor);
  tunnelUniforms.uColor2.value.set(...theme.secondaryColor);
  tunnelUniforms.uColor3.value.set(...theme.accentColor);
  tunnelUniforms.uColor4.value.set(...theme.bgColor);
  const pMat = particles.mesh.material as THREE.PointsMaterial;
  pMat.color.setRGB(...theme.particleColor);
  depthParticles.setColor(...theme.particleColor);
  gpuParticles.setColor(...theme.particleColor);
  fogLayers.setColors(theme.primaryColor, theme.accentColor, theme.bgColor);
  breathCircle.style.borderColor = theme.breatheColor;
  text3d.setColors(theme.textColor, theme.textGlow);
  tunnelUniforms.uTunnelShape.value = theme.tunnelShape ?? 0;
}

// ══════════════════════════════════════════════════════════════════════
// STAGE MANAGER — recreate with fresh callbacks, preserve stage index
// ══════════════════════════════════════════════════════════════════════
const prevStageIndex = hotState.stageManager?.currentIndex;
const stageManager = new StageManager(
  activeSession?.stages ?? sessions[0].stages,
  (text) => {
    if (narration.isPlayingStage || narration.hasStageAudio(stageManager.currentStage.name)) return;
    narration.speak(text);
  },
  (stage: SessionStage, _index: number) => {
    console.log(`Stage: ${stage.name}`);
    audio.setIntensity(stage.intensity);
    narration.stopStagePlayback();
    if (narration.hasStageAudio(stage.name)) {
      narration.playStage(stage.name);
    }
    if (stage.breathPattern) {
      breath.setPattern({
        inhale: stage.breathPattern.inhale,
        holdIn: stage.breathPattern.holdIn ?? 0,
        exhale: stage.breathPattern.exhale,
        holdOut: stage.breathPattern.holdOut ?? 0,
      });
    } else {
      breath.setSimpleCycle(stage.breathCycle);
    }
    breathCircle.style.animationDuration = `${breath.cycleDuration}s`;
    if (_index === 0) {
      breathGuide.classList.add('visible');
    } else if (_index === 1) {
      setTimeout(() => breathGuide.classList.remove('visible'), 5000);
    }
    // Track stage in app state
    setSessionInfo(activeSession?.id ?? '', _index);
  },
);
hotState.stageManager = stageManager;

// ── Interactions ──
const interactions = new InteractionManager(breath, overlayScene, camera, canvas, text3d, narration);
interactions.setMicSignals(() => mic.signals);
hotState.interactions = interactions;

stageManager.setInteractionHandler(async (interaction: Interaction) => {
  const epoch = sessionEpoch;

  // Check experience level — skip interactions the level doesn't include
  const { interactionAllowed } = await import('./experience-level');
  const level = settings.current.experienceLevel;
  if (!interactionAllowed(interaction.type, level)) {
    // At 'listen' level, auto-skip all interactions silently
    return;
  }

  text3d.clear();
  narration.stop();
  stageManager.pause();
  await interactions.start(interaction);
  // Bail if session ended or HMR fired while we were awaiting
  if (epoch !== sessionEpoch || !isRunning) return;
  if (interaction.type === 'breath-sync') {
    text3d.show('continue breathing\njust like that', 5);
    if (narration.hasClip('breath_continue')) {
      await narration.playClip('breath_continue');
    }
    if (epoch !== sessionEpoch || !isRunning) return;
    await new Promise(r => setTimeout(r, 1500));
    if (epoch !== sessionEpoch || !isRunning) return;
    text3d.fadeOut();
  }
  stageManager.advanceStage();
  stageManager.resume();
});

let lastStageEndTime = 0;
narration.setStageEndedHandler(() => {
  // Guard: ignore if session changed or not running
  if (!isRunning) return;
  if (stageManager.isComplete) return;
  // Debounce: don't advance more than once per second (prevents rapid-fire loops)
  const now = performance.now();
  if (now - lastStageEndTime < 1000) return;
  lastStageEndTime = now;

  text3d.fadeOut();
  const stage = stageManager.currentStage;
  if (stage.interactions && stage.interactions.length > 0) {
    stageManager.triggerPendingInteraction();
  } else {
    stageManager.advanceStage();
  }
});

// ── Dev Mode ──
hotState.devMode?.destroy?.();
const devMode = new DevMode({
  stageManager,
  audio,
  interactions,
  getIntensity: () => intensityOverride ?? stageManager.intensity,
  setIntensityOverride: (v) => { intensityOverride = v; },
  getShaderIntensityScale: () => shaderIntensityScale,
  setShaderIntensityScale: (v) => { shaderIntensityScale = v; },
  onRestart: () => {
    stageManager.reset();
    interactions.clear();
    narration.stop();
    audio.setIntensity(stageManager.currentStage.intensity);
    breathGuide.classList.remove('visible');
  },
});
hotState.devMode = devMode;

// ── Settings reactivity ──
settings.onChange((s) => {
  audio.setMuted(s.muted);
  audio.setMasterVolume(s.masterVolume);
  narration.setConfig({ voiceEnabled: s.ttsEnabled, volume: s.narrationVolume });
});
audio.setMuted(settings.current.muted);
audio.setMasterVolume(settings.current.masterVolume);

// ── Calibration ──
let guidedCal: GuidedCalibration | null = null;
settings.onCalibrate(() => {
  if (guidedCal) return;
  settings.hide();
  if (isRunning) stageManager.pause();
  guidedCal = new GuidedCalibration({ scene: overlayScene, camera, canvas, settings, audio, text3d });
  guidedCal.run().then(() => {
    guidedCal = null;
    if (isRunning) stageManager.resume();
  });
});
if (!isHMR) runAutoCalibration(settings);

// ══════════════════════════════════════════════════════════════════════
// THEME PREVIEW — cached lerp targets (no per-frame allocations)
// ══════════════════════════════════════════════════════════════════════
const targetColors = {
  c1: [0.45, 0.1, 0.55] as [number, number, number],
  c2: [0.7, 0.3, 0.9] as [number, number, number],
  c3: [0.6, 0.3, 0.8] as [number, number, number],
  c4: [0.15, 0.02, 0.25] as [number, number, number],
  particle: [0.5, 0.35, 0.9] as [number, number, number],
  shape: 0,
};

// ══════════════════════════════════════════════════════════════════════
// SESSION START — called from selector after orb expansion
// ══════════════════════════════════════════════════════════════════════
function startSession(session: SessionConfig): void {
  // Load manifest FIRST, then start session
  sessionEpoch++;
  activeSession = session;
  setPhase('session');
  setSessionInfo(session.id, 0);

  stageManager.setStages(session.stages);
  applyTheme(session);
  devMode.rebuildStageButtons();

  selector?.dispose?.();
  selector = null;
  hotState.selector = undefined;

  // Load manifest before starting — so stage audio is available from frame 1
  narration.clearManifest();
  narration.loadManifest(`audio/${session.id}/manifest.json`).catch(() => {}).finally(() => {
    isRunning = true;
    stageManager.start();
    animate();
  });

  // Fullscreen + wakelock immediately (needs user gesture context from selector click)
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => {});
  narration.warmup();
  acquireWakeLock();
  registerMediaSession(session.name);
  startSilentAudioKeepAlive();

  // Start audio during fade so it's ready when session begins
  audio.init().then(() => {
    audio.start(session.audio);
    if (audio.context && audio.externalInputNode) {
      const rootNotes: Record<string, number> = {
        relax: 48, sleep: 45, focus: 52, surrender: 50,
      };
      ambient.start(audio.context, audio.masterGainNode!, breath, {
        rootNote: rootNotes[session.id] ?? 48,
        warmth: session.audio.warmth,
        tempo: 5,
        reverbDecay: 4,
      });
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
// BACKGROUND ANIMATION (selector screen)
// ══════════════════════════════════════════════════════════════════════
let selector: SessionSelector | null = null;

function animateBackground(): void {
  if (isRunning) return;
  hotState.bgAnimFrameId = requestAnimationFrame(animateBackground);

  const time = performance.now() / 1000;
  const s = settings.current;
  const rawDt = lastAnimTime > 0 ? time - lastAnimTime : 1 / 60;
  const dt = Math.min(rawDt, 0.1);
  lastAnimTime = time;

  spiralAngle += dt * 0.5 * s.spiralSpeedMult * 0.5;

  breath.update(time);
  tunnelUniforms.uTime.value = time;
  tunnelUniforms.uIntensity.value = 0.12;
  tunnelUniforms.uBreathePhase.value = breath.phase;
  tunnelUniforms.uBreathValue.value = breath.value;
  tunnelUniforms.uBreathStage.value = breathStageToFloat(breath.stage);
  tunnelUniforms.uSpiralSpeed.value = 0.5 * s.spiralSpeedMult;
  tunnelUniforms.uSpiralAngle.value = spiralAngle;
  tunnelUniforms.uTunnelSpeed.value = s.tunnelSpeed;
  tunnelUniforms.uTunnelWidth.value = s.tunnelWidth;
  tunnelUniforms.uBreathExpansion.value = s.breathExpansion;

  camera.position.z = s.cameraZ;
  if (camera.fov !== s.cameraFOV) {
    camera.fov = s.cameraFOV;
    camera.updateProjectionMatrix();
  }

  // Lerp tunnel colors — reuse temp objects instead of allocating
  const lerpSpeed = 0.03;
  const u = tunnelUniforms;
  u.uColor1.value.lerp(_tmpVec3.set(...targetColors.c1), lerpSpeed);
  u.uColor2.value.lerp(_tmpVec3.set(...targetColors.c2), lerpSpeed);
  u.uColor3.value.lerp(_tmpVec3.set(...targetColors.c3), lerpSpeed);
  u.uColor4.value.lerp(_tmpVec3.set(...targetColors.c4), lerpSpeed);
  u.uTunnelShape.value += (targetColors.shape - u.uTunnelShape.value) * lerpSpeed;
  const pMat = particles.mesh.material as THREE.PointsMaterial;
  const tc = targetColors.particle;
  pMat.color.lerp(_tmpColor.setRGB(tc[0], tc[1], tc[2]), lerpSpeed);
  depthParticles.setColor(tc[0], tc[1], tc[2]);
  gpuParticles.setColor(tc[0], tc[1], tc[2]);

  particles.update(0.1, time, s.particleOpacity, s.particleSize);
  depthParticles.update(0.1, time, s.particleOpacity, s.particleSize);
  gpuParticles.update(time, 0.1, s.particleOpacity, s.particleSize);
  fogLayers.update(time, breath.value, 0.12);
  if (selector) {
    selector.setDepth(s.menuDepth);
    selector.setScale(s.menuScale);
    selector.update(time);
  }
  if (guidedCal) guidedCal.update(time);
  autoCalibrationFrameHook?.();

  // Transition: update state and sync fade overlay
  transition.update();
  (fadeOverlay.material as THREE.MeshBasicMaterial).opacity = transition.state.fadeAmount;
  fadeOverlay.visible = transition.state.fadeAmount > 0.001;

  // Feedback warp pipeline: render tunnel/particles/fog → feedback composite → display
  const bgIntensity = 0.12 * transition.state.intensityMult;
  renderer.setRenderTarget(feedback.tunnelTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  const compositeTex = feedback.render(renderer, time, bgIntensity);
  (compositeQuad.material as THREE.MeshBasicMaterial).map = compositeTex;
  renderer.render(compositeScene, compositeCamera);

  // Overlay: text, selector, interactions — rendered sharp on top (no feedback blur)
  renderer.autoClear = false;
  renderer.render(overlayScene, camera);
  renderer.autoClear = true;
}

// ══════════════════════════════════════════════════════════════════════
// SESSION ANIMATION LOOP
// ══════════════════════════════════════════════════════════════════════
function animate(): void {
  if (!isRunning) return;
  hotState.animFrameId = requestAnimationFrame(animate);

  const time = performance.now() / 1000;
  const s = settings.current;

  stageManager.update();
  mic.update();
  narration.update();
  const intensity = intensityOverride ?? stageManager.intensity;

  const micSig = mic.signals;
  if (micSig.active) {
    breath.setFromMic(micSig.breathPhase);
  }
  breath.update(time);
  const breathPhase = breath.phase;

  const analyzer = audio.analyzer;
  let audioBands: AudioBands | null = null;
  if (analyzer) {
    audioBands = analyzer.update();
  }

  const rawDt = lastAnimTime > 0 ? time - lastAnimTime : 1 / 60;
  const dt = Math.min(rawDt, 0.1);
  lastAnimTime = time;
  spiralAngle += dt * stageManager.spiralSpeed * s.spiralSpeedMult * 0.5;

  tunnelUniforms.uTime.value = time;
  tunnelUniforms.uIntensity.value = intensity * shaderIntensityScale;
  // Lerp mouse — reuse temp vector
  tunnelUniforms.uMouse.value.lerp(_tmpVec2.set(mouse.x, mouse.y), 0.02);
  tunnelUniforms.uBreathePhase.value = breathPhase;
  tunnelUniforms.uBreathValue.value = breath.value;
  tunnelUniforms.uBreathStage.value = breathStageToFloat(breath.stage);
  tunnelUniforms.uSpiralSpeed.value = stageManager.spiralSpeed * s.spiralSpeedMult;
  tunnelUniforms.uSpiralAngle.value = spiralAngle;
  tunnelUniforms.uTunnelSpeed.value = s.tunnelSpeed;
  tunnelUniforms.uTunnelWidth.value = s.tunnelWidth;
  tunnelUniforms.uBreathExpansion.value = s.breathExpansion;

  if (audioBands) {
    tunnelUniforms.uAudioEnergy.value = audioBands.energy;
    tunnelUniforms.uAudioBass.value = audioBands.bass;
    tunnelUniforms.uAudioMid.value = audioBands.mid;
    tunnelUniforms.uAudioHigh.value = audioBands.high;
  }

  tunnelUniforms.uVoiceEnergy.value = narration.state.voiceEnergy;

  let micBoost = 0;
  if (micSig.active && micSig.isHumming) {
    micBoost = micSig.volume * 0.3;
  }
  tunnelUniforms.uIntensity.value += micBoost;

  particles.update(intensity, time, s.particleOpacity, s.particleSize);
  depthParticles.update(intensity, time, s.particleOpacity, s.particleSize);
  gpuParticles.update(time, intensity, s.particleOpacity, s.particleSize);
  fogLayers.update(time, breath.value, intensity);
  text3d.setSettings({ startZ: s.narrationStartZ, endZ: s.narrationEndZ, scale: s.narrationScale });
  text3d.update(intensity, breathPhase);

  interactions.setDepth(s.interactionDepth);
  interactions.setScale(s.interactionScale);
  interactions.update(time, intensity, breath.value);

  ambient.update();

  const iState = interactions.shaderState;
  tunnelUniforms.uBreathSyncActive.value = iState.breathSyncActive;
  tunnelUniforms.uBreathSyncFill.value = iState.breathSyncFill;
  tunnelUniforms.uBreathSyncProgress.value = iState.breathSyncProgress;

  camera.position.z = s.cameraZ;
  if (camera.fov !== s.cameraFOV) {
    camera.fov = s.cameraFOV;
    camera.updateProjectionMatrix();
  }

  camera.position.x = Math.sin(time * 0.1) * 0.02 * intensity * s.cameraSway;
  camera.position.y = Math.cos(time * 0.13) * 0.02 * intensity * s.cameraSway;
  camera.lookAt(0, 0, 0);

  if (guidedCal) guidedCal.update(time);

  // Transition: update state and sync fade overlay
  transition.update();
  (fadeOverlay.material as THREE.MeshBasicMaterial).opacity = transition.state.fadeAmount;
  fadeOverlay.visible = transition.state.fadeAmount > 0.001;

  // Apply transition intensity multiplier
  const renderIntensity = intensity * transition.state.intensityMult;

  // Feedback warp pipeline: render scene → feedback composite → display
  renderer.setRenderTarget(feedback.tunnelTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  feedback.setParams({
    zoom: 0.004 + renderIntensity * 0.006,
    rotation: 0.0005 + renderIntensity * 0.001,
  });

  const compositeTex = feedback.render(renderer, time, renderIntensity);
  (compositeQuad.material as THREE.MeshBasicMaterial).map = compositeTex;
  renderer.render(compositeScene, compositeCamera);

  // Overlay: text, interactions — rendered sharp on top (no feedback blur)
  renderer.autoClear = false;
  renderer.render(overlayScene, camera);
  renderer.autoClear = true;

  devMode.update();

  // Track stage for HMR
  appState.stageIndex = stageManager.currentIndex;

  if (stageManager.isComplete) {
    endExperience();
  }
}

// ══════════════════════════════════════════════════════════════════════
// END EXPERIENCE — fade through tunnel, return to selector
// ══════════════════════════════════════════════════════════════════════
function endExperience(): void {
  if (transition.isActive) return; // Already transitioning

  // Show farewell text before fading
  showText('welcome back');

  transition.run(() => {
    // ── At the darkest moment: clean up session, boot selector ──
    sessionEpoch++;
    isRunning = false;
    setPhase('selector');
    releaseWakeLock();
    clearMediaSession();
    stopSilentAudioKeepAlive();
    audio.fadeOut(2);
    ambient.stop();
    interactions.clear();
    narration.stop();
    text3d.clear();
    activeSession = null;

    bootSelector();
  }, { fadeOutMs: 3000, holdMs: 500, fadeInMs: 2000 });
}

/**
 * Return to menu from a running session (Escape key).
 * Faster transition than end-of-experience.
 */
function returnToMenu(): void {
  if (transition.isActive) return;

  transition.run(() => {
    sessionEpoch++;
    isRunning = false;
    setPhase('selector');
    releaseWakeLock();
    clearMediaSession();
    stopSilentAudioKeepAlive();
    audio.fadeOut(1);
    ambient.stop();
    interactions.clear();
    narration.stop();
    text3d.clear();
    activeSession = null;
    breathGuide.classList.remove('visible');

    // Exit fullscreen
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
    }

    bootSelector();
  }, { fadeOutMs: 1200, holdMs: 300, fadeInMs: 1500 });
}

// ══════════════════════════════════════════════════════════════════════
// STATE-AWARE BOOT — route based on where we are in the experience
// ══════════════════════════════════════════════════════════════════════
function boot(): void {
  const phase = appState.phase;

  if (isHMR) {
    console.log(`[HMR] Restoring phase: ${phase}`);
  }

  switch (phase) {
    case 'session': {
      // Mid-session HMR — skip selector, restart current stage cleanly
      if (activeSession) {
        applyTheme(activeSession);
        devMode.rebuildStageButtons();

        // Stop any leftover narration/text from the old module
        narration.stop();
        narration.stopStagePlayback();
        text3d.clear();
        interactions.clear();

        // Restart at the current stage (fires onStageChange exactly once)
        const idx = prevStageIndex ?? appState.stageIndex;
        stageManager.resumeAt(idx);

        isRunning = true;
        animate();
        console.log(`[HMR] Restarted stage ${idx} (${stageManager.currentStage.name})`);
      } else {
        setPhase('selector');
        bootSelector();
      }
      break;
    }

    case 'ended': {
      // After session ended — return to selector
      bootSelector();
      break;
    }

    case 'boot':
    case 'selector':
    default: {
      bootSelector();
      break;
    }
  }
}

function bootSelector(): void {
  setPhase('selector');
  isRunning = false;

  // Dispose previous selector if HMR recreated us
  hotState.selector?.dispose?.();
  hotState.selector = undefined;

  selector = new SessionSelector(sessions, startSession, overlayScene, camera, canvas);
  hotState.selector = selector;

  selector.setThemeControl((colors) => {
    targetColors.c1 = colors.c1;
    targetColors.c2 = colors.c2;
    targetColors.c3 = colors.c3;
    targetColors.c4 = colors.c4;
    targetColors.particle = colors.particle;
    targetColors.shape = colors.shape;
  });

  selector.setExperienceLevelControl((level) => {
    settings.updateBatch({ experienceLevel: level });
  });

  animateBackground();
}

// ══════════════════════════════════════════════════════════════════════
// INPUT — registered once, cleaned up on HMR
// ══════════════════════════════════════════════════════════════════════
const onMouseMove = (e: MouseEvent) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
};
const onTouchMove = (e: TouchEvent) => {
  if (e.touches.length > 0) {
    const t = e.touches[0];
    mouse.x = (t.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(t.clientY / window.innerHeight) * 2 + 1;
  }
};
const onKeyDown = (e: KeyboardEvent) => {
  if (e.code === 'Escape' && isRunning && !transition.isActive) {
    returnToMenu();
  }
};
document.addEventListener('mousemove', onMouseMove);
document.addEventListener('touchmove', onTouchMove, { passive: true });
document.addEventListener('keydown', onKeyDown);
onCleanup(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('touchmove', onTouchMove);
  document.removeEventListener('keydown', onKeyDown);
});

function handleResize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  tunnelUniforms.uResolution.value.set(w, h);
  feedback.resize(w, h);
  fogLayers.resize(w, h);
}
window.addEventListener('resize', handleResize);
const onOrientationChange = () => setTimeout(handleResize, 100);
window.addEventListener('orientationchange', onOrientationChange);
onCleanup(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('orientationchange', onOrientationChange);
});

// ══════════════════════════════════════════════════════════════════════
// GO
// ══════════════════════════════════════════════════════════════════════
boot();

// ══════════════════════════════════════════════════════════════════════
// HMR — snapshot state before next reload
// ══════════════════════════════════════════════════════════════════════
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    hotState.isRunning = isRunning;
    hotState.activeSession = activeSession;
    hotState.spiralAngle = spiralAngle;
    hotState.lastAnimTime = lastAnimTime;
    hotState.intensityOverride = intensityOverride;
    hotState.shaderIntensityScale = shaderIntensityScale;
  });
}
