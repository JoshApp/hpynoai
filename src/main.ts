import * as THREE from 'three';
import { AudioEngine } from './audio';
import { Timeline, type TimelineState, type TimelineSegment } from './timeline';
import { Timebar } from './timebar';
import { DevMode } from './devmode';
import { InteractionManager } from './interactions';
import { SessionSelector } from './selector';
import { sessions } from './sessions/index';
import { MicrophoneEngine } from './microphone';
import { NarrationEngine } from './narration';
import type { SessionConfig, SessionStage, Interaction } from './session';
import { Text3D } from './text3d';
import { SettingsManager } from './settings';
import { runAutoCalibration, autoCalibrationFrameHook } from './calibration-auto';
import { GuidedCalibration } from './calibration-guided';
import { BreathController } from './breath';
import { AmbientEngine } from './ambient';
import { Presence } from './presence';
import { hotState } from './hot-state';
import { appState, setPhase, setSessionInfo } from './app-state';
import { EventBus } from './events';
import { StateMachine } from './state-machine';
import { acquireWakeLock, releaseWakeLock, registerMediaSession, clearMediaSession, startSilentAudioKeepAlive, stopSilentAudioKeepAlive } from './wakelock';
import { FeedbackWarp } from './feedback';
import { RenderPipeline, type FrameState } from './render-pipeline';
import { GpuParticles } from './gpu-particles';
import { InputController } from './input';
import { TransitionManager } from './transition';
import tunnelVert from './shaders/tunnel.vert';
import tunnelFrag from './shaders/tunnel.frag';
import { checkWebGL, installGlobalErrorHandler } from './error-boundary';
import { registerServiceWorker } from './sw-register';
import { LoadingIndicator } from './loading';
import { log } from './logger';

// ══════════════════════════════════════════════════════════════════════
// ERROR BOUNDARIES — check before anything else
// ══════════════════════════════════════════════════════════════════════
installGlobalErrorHandler();
registerServiceWorker();
if (!checkWebGL()) throw new Error('WebGL not available');

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
// EVENT BUS + STATE MACHINE
// ══════════════════════════════════════════════════════════════════════
const bus = hotState.eventBus ?? new EventBus();
hotState.eventBus = bus;
bus.clear(); // wipe stale listeners from previous HMR cycle
onCleanup(() => bus.clear());

const machine = hotState.stateMachine ?? new StateMachine(
  isHMR ? (appState.phase === 'session' ? 'session' : 'boot') : 'boot'
);
hotState.stateMachine = machine;
machine.setBus(bus);

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
    log.info('hmr', 'Shader updated');
  }
  // Ensure new uniforms exist on reused material
  if (!tunnelMaterial.uniforms.uPresencePos) {
    tunnelMaterial.uniforms.uPresencePos = { value: new THREE.Vector3(0, 0, -1.5) };
  }
  if (!tunnelMaterial.uniforms.uPortalColor1) {
    tunnelMaterial.uniforms.uPortalColor1 = { value: new THREE.Vector3(0.45, 0.1, 0.55) };
    tunnelMaterial.uniforms.uPortalColor2 = { value: new THREE.Vector3(0.7, 0.3, 0.9) };
    tunnelMaterial.uniforms.uPortalBlend = { value: 0 };
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
      uPresencePos: { value: new THREE.Vector3(0, 0, -1.5) },
      uPortalColor1: { value: new THREE.Vector3(0.45, 0.1, 0.55) },
      uPortalColor2: { value: new THREE.Vector3(0.7, 0.3, 0.9) },
      uPortalBlend: { value: 0 },
    },
  });
  tunnelPlane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), tunnelMaterial);
  scene.add(tunnelPlane);
}
hotState.tunnelMaterial = tunnelMaterial;
hotState.tunnelPlane = tunnelPlane;
const tunnelUniforms = tunnelMaterial.uniforms;

// ── Particles (GPU-driven, zero CPU cost) ──
// GPU particles — hidden for now, energy shimmer baked into tunnel shader instead
const gpuParticles = hotState.gpuParticles ?? (() => {
  const gp = new GpuParticles(250);
  // scene.add(gp.mesh); — disabled: round particles look like light explosions
  return gp;
})();
hotState.gpuParticles = gpuParticles;
gpuParticles.mesh.visible = false;
// Note: fog is baked into tunnel.frag — no separate fog layer needed

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

const loading = new LoadingIndicator(overlayScene);

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

// ── Presence (before render pipeline — it depends on it) ──
const presence = hotState.presence ?? (() => {
  const p = new Presence();
  scene.add(p.mesh);
  return p;
})();
hotState.presence = presence;
presence.connectBus(bus);

// ── Render Pipeline ──
const renderPipeline = new RenderPipeline({
  renderer, scene, overlayScene, camera,
  tunnelUniforms: tunnelMaterial.uniforms,
  feedback, compositeQuad, compositeScene, compositeCamera,
  fadeOverlay, gpuParticles, presence,
});

// ── Audio/mic ──
const audio = hotState.audio ?? new AudioEngine();
hotState.audio = audio;
audio.connectBus(bus);

const ambient = hotState.ambient ?? new AmbientEngine();
hotState.ambient = ambient;
// ambient.connectBus needs breath — connected after breath is created below

const mic = hotState.mic ?? new MicrophoneEngine();
hotState.mic = mic;

// ── Breath ──
const breath = hotState.breath ?? (() => {
  const b = new BreathController();
  b.setSimpleCycle(10);
  return b;
})();
hotState.breath = breath;
breath.connectBus(bus);
ambient.connectBus(bus, audio, breath);

// ── Narration ──
const narration = hotState.narration ?? new NarrationEngine({
  voiceEnabled: settings.current.ttsEnabled,
  rate: 0.85,
  pitch: 0.9,
  volume: settings.current.narrationVolume,
});
hotState.narration = narration;
narration.connectBus(bus);

bus.on('narration:line', ({ text, words, audioStartTime }) => {
  showText(text, words, audioStartTime);
});

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
  renderPipeline.applyTheme(session.theme);
  breathCircle.style.borderColor = session.theme.breatheColor;
  text3d.setColors(session.theme.textColor, session.theme.textGlow);
}

// ══════════════════════════════════════════════════════════════════════
// TIMELINE — single source of truth for session progression
// ══════════════════════════════════════════════════════════════════════
const timeline = new Timeline();

// Wire timeline callbacks → bus events
timeline.onSegmentChange((seg, prev) => {
  bus.emit('stage:changed', { stage: seg.stage, index: seg.index, total: timeline.segmentCount });
});
timeline.onText((text, seg) => {
  bus.emit('stage:text', { text });
});
timeline.onInteraction((interaction, seg) => {
  bus.emit('interaction:trigger', { interaction });
});
timeline.onComplete(() => {
  endExperience();
});

// Timebar — dev widget for timeline scrubbing (toggle with T key)
const timebar = new Timebar(timeline);

// ── Stage event subscribers ──
// stage:text and stage:changed → audio/narration/breath handle themselves via bus.
// Main.ts only handles UI (breathing guide, app state tracking).
bus.on('stage:changed', ({ stage, index }) => {
  log.info('stage', `Stage: ${stage.name}`, { index, stage: stage.name });
  breathCircle.style.animationDuration = `${breath.cycleDuration}s`;
  if (index === 0) {
    breathGuide.classList.add('visible');
  } else if (index === 1) {
    setTimeout(() => breathGuide.classList.remove('visible'), 5000);
  }
  setSessionInfo(activeSession?.id ?? '', index);
});

// ── Interactions ──
const interactions = new InteractionManager(breath, overlayScene, camera, canvas, text3d, narration);
interactions.setMicSignals(() => mic.signals);
interactions.setBus(bus);
interactions.setPresenceControl({
  breatheMode: () => {
    presence.transitionTo('breathe', {
      size: 3.0,
      basePos: new THREE.Vector3(0, 0, -1.0),
      duration: 1.5,
    });
  },
  sessionMode: () => { presence.setSessionMode(); },
  getPresence: () => presence,
});
hotState.interactions = interactions;

// Interaction handler — timeline fires the event, we pause/run/resume
bus.on('interaction:trigger', async ({ interaction }) => {
  const epoch = machine.epoch;

  const { interactionAllowed } = await import('./experience-level');
  const level = settings.current.experienceLevel;
  if (!interactionAllowed(interaction.type, level)) return;

  text3d.clear();
  narration.stop();
  timeline.pause();
  await interactions.start(interaction);

  if (!machine.guard(epoch)) return;

  timeline.resume();
  bus.emit('interaction:complete', { type: interaction.type });
});

// Narration stage audio ended → tell timeline to unbind audio clock
// (Timeline will auto-advance via its own position tracking)
bus.on('narration:stage-ended', () => {
  if (!machine.is('session')) return;
  timeline.audioEnded();
  text3d.fadeOut();
});

// When narration starts playing stage audio, bind it as timeline clock
bus.on('narration:stage-playing', ({ audioElement, stageName }) => {
  if (!machine.is('session')) return;
  const seg = timeline.currentSegment;
  if (seg && audioElement) {
    timeline.bindAudio(audioElement, seg.start);
  }
});

// ── Dev Mode ──
hotState.devMode?.destroy?.();
const devMode = new DevMode({
  timeline,
  audio,
  interactions,
  getIntensity: () => intensityOverride ?? (timeline.started ? (timeline.currentSegment?.stage.intensity ?? 0.12) : 0.12),
  setIntensityOverride: (v) => { intensityOverride = v; },
  getShaderIntensityScale: () => shaderIntensityScale,
  setShaderIntensityScale: (v) => { shaderIntensityScale = v; },
  onRestart: () => {
    timeline.seek(0);
    interactions.clear();
    narration.stop();
    breathGuide.classList.remove('visible');
  },
});
hotState.devMode = devMode;

// ── Settings reactivity ──
// Settings changes → bus. Audio/narration handle themselves.
settings.onChange((s) => {
  bus.emit('settings:changed', { settings: s });
});

// ── Calibration ──
let guidedCal: GuidedCalibration | null = null;
settings.onCalibrate(() => {
  if (guidedCal) return;
  settings.hide();
  if (isRunning) timeline.pause();
  guidedCal = new GuidedCalibration({ scene: overlayScene, camera, canvas, settings, audio, text3d, bus });
  guidedCal.run().then(() => {
    guidedCal = null;
    if (isRunning) timeline.resume();
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
  log.info('session', `Starting: ${session.name}`, { id: session.id, stages: session.stages.length });
  // Load manifest FIRST, then start session
  sessionEpoch++;
  activeSession = session;
  setPhase('session');
  setSessionInfo(session.id, 0);
  machine.transition('transitioning', { sessionId: session.id });
  bus.emit('session:starting', { session });

  // Build timeline from session stages
  timeline.build(
    session.stages,
    (name) => narration.hasStageAudio(name),
    (name) => narration.getStageAudioDuration(name),
  );
  applyTheme(session);
  timebar.buildSegments();
  devMode.rebuildStageButtons();

  selector?.dispose?.();
  selector = null;
  hotState.selector = undefined;

  // Fullscreen + wakelock (needs user gesture context from selector click)
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => {});
  acquireWakeLock();
  registerMediaSession(session.name);
  startSilentAudioKeepAlive();

  // Loading indicator while audio/manifest loads
  const doneLoading = loading.start('preparing session');

  // Wait for audio to initialize, then start the session
  // Audio, narration, ambient all react to bus events (session:starting, session:started)
  audio.init().then(() => {
    doneLoading();
    isRunning = true;
    machine.transition('session');
    bus.emit('session:started', { session });
    timeline.start();
    animate();
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

  // Update subsystems
  if (selector) {
    selector.setDepth(s.menuDepth);
    selector.setScale(s.menuScale);
    selector.update(time);
  }
  if (guidedCal) guidedCal.update(time);
  loading.update(time);
  autoCalibrationFrameHook?.();
  transition.update();

  // Build frame state and render
  const frame: FrameState = {
    time, dt, settings: s,
    breathPhase: breath.phase, breathValue: breath.value, breathStage: breath.stage,
    intensity: 0.12, spiralAngle, spiralSpeed: 0.5,
    mouseX: mouse.x, mouseY: mouse.y,
    audioBands: null, voiceEnergy: 0, micBoost: 0,
    breathSyncActive: 0, breathSyncFill: 0, breathSyncProgress: 0,
    fadeAmount: transition.state.fadeAmount,
    intensityMult: transition.state.intensityMult,
    targetColors,
  };
  renderPipeline.renderBackground(frame);
}

// ══════════════════════════════════════════════════════════════════════
// SESSION ANIMATION LOOP
// ══════════════════════════════════════════════════════════════════════
function animate(): void {
  if (!isRunning) return;
  hotState.animFrameId = requestAnimationFrame(animate);

  const time = performance.now() / 1000;
  const s = settings.current;

  // Update subsystems
  const tlState = timeline.update();
  mic.update();
  narration.update();
  const intensity = intensityOverride ?? (tlState?.intensity ?? 0.12);

  const micSig = mic.signals;
  if (micSig.active) breath.setFromMic(micSig.breathPhase);
  breath.update(time);

  const audioBands = audio.analyzer?.update() ?? null;

  const rawDt = lastAnimTime > 0 ? time - lastAnimTime : 1 / 60;
  const dt = Math.min(rawDt, 0.1);
  lastAnimTime = time;
  spiralAngle += dt * (tlState?.spiralSpeed ?? 1) * s.spiralSpeedMult * 0.5;

  // Update scene objects
  text3d.setSettings({ startZ: s.narrationStartZ, endZ: s.narrationEndZ, scale: s.narrationScale });
  text3d.update(intensity, breath.phase);
  interactions.setDepth(s.interactionDepth);
  interactions.setScale(s.interactionScale);
  interactions.update(time, intensity, breath.value);
  ambient.update();
  if (guidedCal) guidedCal.update(time);
  transition.update();
  devMode.update();

  // Build frame state and render
  const iState = interactions.shaderState;
  let micBoost = 0;
  if (micSig.active && micSig.isHumming) micBoost = micSig.volume * 0.3;

  const frame: FrameState = {
    time, dt, settings: s,
    breathPhase: breath.phase, breathValue: breath.value, breathStage: breath.stage,
    intensity: intensity * shaderIntensityScale, spiralAngle,
    spiralSpeed: tlState?.spiralSpeed ?? 1,
    mouseX: mouse.x, mouseY: mouse.y,
    audioBands, voiceEnergy: narration.state.voiceEnergy, micBoost,
    breathSyncActive: iState.breathSyncActive,
    breathSyncFill: iState.breathSyncFill,
    breathSyncProgress: iState.breathSyncProgress,
    fadeAmount: transition.state.fadeAmount,
    intensityMult: transition.state.intensityMult,
  };
  renderPipeline.renderSession(frame);

  appState.stageIndex = timeline.currentIndex;
  timebar.update();
  // Completion is handled by timeline.onComplete callback
}

// ══════════════════════════════════════════════════════════════════════
// END EXPERIENCE — fade through tunnel, return to selector
// ══════════════════════════════════════════════════════════════════════
/** Shared cleanup for any session → selector transition */
function cleanupSession(): void {
  log.info('session', 'Cleanup — returning to selector');
  sessionEpoch++;
  isRunning = false;
  setPhase('selector');
  machine.transition('selector');
  bus.emit('session:ended', {});

  // Release platform locks
  releaseWakeLock();
  clearMediaSession();
  stopSilentAudioKeepAlive();

  // Audio/ambient/narration/presence handle session:ended via bus.
  // Only clear UI systems that aren't bus-connected yet.
  interactions.clear();
  text3d.clear();
  activeSession = null;
  breathGuide.classList.remove('visible');

  // Exit fullscreen
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
  }

  bootSelector();
}

function endExperience(): void {
  if (transition.isActive) return;
  showText('welcome back');
  machine.transition('ending');
  bus.emit('session:ending', { fadeSec: 3 });
  transition.run(() => cleanupSession(), { fadeOutMs: 3000, holdMs: 500, fadeInMs: 2000 });
}

function returnToMenu(): void {
  if (transition.isActive) return;
  machine.transition('ending');
  bus.emit('session:ending', { fadeSec: 1 });
  transition.run(() => cleanupSession(), { fadeOutMs: 1200, holdMs: 300, fadeInMs: 1500 });
}

// ══════════════════════════════════════════════════════════════════════
// STATE-AWARE BOOT — route based on where we are in the experience
// ══════════════════════════════════════════════════════════════════════
function boot(): void {
  const phase = appState.phase;

  if (isHMR) {
    log.info('hmr', `Restoring phase: ${phase}`);
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

        // Rebuild timeline and seek to current position
        timeline.build(
          activeSession.stages,
          (name) => narration.hasStageAudio(name),
          (name) => narration.getStageAudioDuration(name),
        );
        timeline.start();
        // Seek to roughly where we were (stage start)
        const idx = appState.stageIndex;
        if (idx > 0 && idx < timeline.segmentCount) {
          timeline.seek(timeline.allSegments[idx].start);
        }

        isRunning = true;
        animate();
        log.info('hmr', `Restarted at segment ${idx}`);
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

  selector = new SessionSelector(sessions, startSession, overlayScene, camera, canvas, bus);
  hotState.selector = selector;

  selector.setExperienceLevelControl((level) => {
    settings.updateBatch({ experienceLevel: level });
  });

  // Tell presence to enter menu mode via bus
  bus.emit('selector:ready', {});
  selector.setPresenceControl((x, y, z) => {
    presence.followTo(x, y, z);
  }, () => {
    presence.pulse();
  });
  selector.setThemeControl((colors) => {
    targetColors.c1 = colors.c1;
    targetColors.c2 = colors.c2;
    targetColors.c3 = colors.c3;
    targetColors.c4 = colors.c4;
    targetColors.particle = colors.particle;
    targetColors.shape = colors.shape;
    // Presence color follows the accent color of the hovered session
    presence.setColors(colors.c3 as [number, number, number]);
  });

  animateBackground();
}

// ══════════════════════════════════════════════════════════════════════
// INPUT CONTROLLER — centralized input, emits semantic events on bus
// ══════════════════════════════════════════════════════════════════════
hotState.inputController?.dispose();
const input = new InputController(bus, canvas);
hotState.inputController = input;
onCleanup(() => input.dispose());

// Sync pointer into mouse object (used by shader uniform lerp)
bus.on('input:pointer-move', ({ x, y }) => {
  mouse.x = x;
  mouse.y = y;
});

// Escape → return to menu
bus.on('input:back', () => {
  if (machine.is('session') && !transition.isActive) {
    returnToMenu();
  }
});

function handleResize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  tunnelUniforms.uResolution.value.set(w, h);
  feedback.resize(w, h);
}
window.addEventListener('resize', handleResize);
const onOrientationChange = () => setTimeout(handleResize, 100);
window.addEventListener('orientationchange', onOrientationChange);
onCleanup(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('orientationchange', onOrientationChange);
});

// ══════════════════════════════════════════════════════════════════════
// VISIBILITY — handle tab away / tab back gracefully
// ══════════════════════════════════════════════════════════════════════
const onVisibilityChange = () => {
  if (document.hidden) {
    log.info('visibility', 'Tab hidden');
  } else {
    // Tab back — reset frame delta to prevent huge dt spike
    lastAnimTime = 0;
    log.info('visibility', `Tab resumed, timeline position: ${timeline.position.toFixed(1)}s`);

    // Resume audio context if it was suspended
    if (audio.context?.state === 'suspended') {
      audio.context.resume().catch(() => {});
    }

    // Timeline handles sync automatically:
    // - If audio was bound, position = audio.currentTime (already correct)
    // - If wall clock, position continued advancing (correct for TTS)
    // - update() will fire any missed events on next frame
  }
};
document.addEventListener('visibilitychange', onVisibilityChange);
onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));

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
