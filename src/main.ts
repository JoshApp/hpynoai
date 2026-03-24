import * as THREE from 'three';
import { AudioEngine } from './audio';
import { Timeline, type TimelineState } from './timeline';
import { Timebar } from './timebar';
import { DevMode } from './devmode';
import { InteractionManager } from './interactions';
import { SessionSelector } from './selector';
import { sessions, getSession } from './sessions/index';
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
import { createHypnoAPI, type HypnoAPI } from './api';
import { sessionHistory } from './history';
import { TelemetryAggregator } from './telemetry';
import { FrameProfiler } from './frame-profiler';
import { parseIsolationParams, type IsolationConfig, type ShaderIsolation } from './isolation';
import { Favorites } from './favorites';
import { initConsoleProtocol, teardownConsoleProtocol } from './console-protocol';
import { auth } from './auth';
import { showPostSessionPrompt, autoAnonymousSignIn } from './post-session-prompt';
import { SettingsSync } from './settings-sync';
import { supabase } from './supabase';

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
teardownConsoleProtocol();
if (hotState.cleanupFns) {
  for (const fn of hotState.cleanupFns) fn();
}
hotState.cleanupFns = [];

function onCleanup(fn: () => void): void {
  hotState.cleanupFns!.push(fn);
}
onCleanup(() => auth.destroy());

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

// ══════════════════════════════════════════════════════════════════════
// SUBSYSTEMS — reuse across HMR, create only on first load
// ══════════════════════════════════════════════════════════════════════
const settings = hotState.settings ?? new SettingsManager();
hotState.settings = settings;

// Settings sync — wire Supabase client here when available (null = no-op mode)
// TODO: Replace null with Supabase client from src/supabase.ts when #3225 lands
const settingsSync = new SettingsSync(null, settings);
settingsSync.init();
onCleanup(() => settingsSync.dispose());

const favorites = hotState.favorites ?? new Favorites(null);
hotState.favorites = favorites;

const mouse = { x: 0, y: 0 };

// ── Fullscreen toggle button ──
const fsBtn = document.getElementById('fullscreen-btn') ?? (() => {
  const btn = document.createElement('button');
  btn.id = 'fullscreen-btn';
  btn.textContent = '\u26F6'; // ⛶ expand
  btn.title = 'Toggle fullscreen';
  document.body.appendChild(btn);
  return btn;
})();

function updateFsIcon(): void {
  const doc = document as Document & { webkitFullscreenElement?: Element };
  const isFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  fsBtn.textContent = isFs ? '\u2716' : '\u26F6'; // ✖ or ⛶
  fsBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
}

fsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
  } else {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => {});
  }
});

document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);

/**
 * Session lifecycle guard — monotonic counter incremented on every state transition.
 * Async callbacks capture the epoch at start and bail if it changed while awaiting.
 * This eliminates race conditions from stale callbacks firing after transitions.
 */
let sessionEpoch = 0;

let activeHistoryEntryId: string | null = null;
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
  // Focus mode: single-point word stream (default for narration with word timings)
  if (words && words.length > 0) {
    const duration = words[words.length - 1].end + 0.5;
    text3d.showFocus(text, duration, words, audioRef, audioStartTime);
  } else {
    // Fallback to karaoke for text without word timings
    text3d.show(text, 8, words, audioRef, audioStartTime);
  }
}

function applyTheme(session: SessionConfig): void {
  renderPipeline.applyTheme(session.theme);
  text3d.setColors(session.theme.textColor, session.theme.textGlow);
}

// ══════════════════════════════════════════════════════════════════════
// TIMELINE — single source of truth for session progression
// ══════════════════════════════════════════════════════════════════════
const timeline = new Timeline();
let hypnoApi: HypnoAPI | null = null;
const telemetry = new TelemetryAggregator();
const profiler = new FrameProfiler();

/** Wire assertion engine subsystem deps after API (re-)creation. */
function wireAssertSubsystems(api: HypnoAPI): void {
  api.assert?.setSubsystems({
    renderer, tunnelUniforms: tunnelMaterial.uniforms, audio, narration,
  });
}

// Pull-model: timeline callbacks removed. The animate loop reads TimelineState
// each frame and drives narration, text, breath, interactions directly.
// If any frame errors, the next frame derives the correct state from position.

// Track state for edge detection in animate loop
let _lastTextKey: string | null = null;
let _wasNarrationPlaying = false;
let _narrationBound = false;
let _completionHandled = false;
let _lastBreathStage: string | null = null;
let _breathClip: HTMLAudioElement | null = null;

// Isolation mode: auto-stop when position exceeds this boundary (seconds)
let _isolationBoundary: number | null = null;

/** Play a breathing cue clip, crossfading from previous */
function playBreathClip(name: string): void {
  // Fade out old clip
  if (_breathClip) {
    const old = _breathClip;
    _breathClip = null;
    const startVol = old.volume;
    const fadeStart = performance.now();
    const fade = () => {
      const t = Math.min(1, (performance.now() - fadeStart) / 300);
      old.volume = startVol * (1 - t);
      if (t < 1) requestAnimationFrame(fade);
      else old.pause();
    };
    requestAnimationFrame(fade);
  }
  try {
    const clip = new Audio(`audio/shared/${name}.mp3`);
    clip.volume = 0.7;
    clip.play().catch(() => {});
    _breathClip = clip;
  } catch { /* no audio */ }
}

// Timebar — dev widget for timeline scrubbing (toggle with T key)
const timebar = new Timebar(timeline);

// ── Stage events now driven by pull-model in animate() ──

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

// Interaction confirm handler — called when user confirms at an interaction boundary
function confirmInteractionBoundary(): void {
  if (!timeline.paused) return;
  timeline.resume();
  bus.emit('interaction:complete', { type: 'gate' });
}

// Wire user input to interaction confirmation
bus.on('input:confirm', () => {
  if (timeline.started && timeline.paused) {
    confirmInteractionBoundary();
  }
});

// narration:line is still emitted by narration for karaoke word timing (kept).

// ── Dev Mode ──
hotState.devMode?.destroy?.();
const devMode = new DevMode({
  timeline,
  audio,
  interactions,
  getIntensity: () => intensityOverride ?? (timeline.started ? (timeline.currentBlock?.stage.intensity ?? 0.12) : 0.12),
  setIntensityOverride: (v) => { intensityOverride = v; },
  getShaderIntensityScale: () => shaderIntensityScale,
  setShaderIntensityScale: (v) => { shaderIntensityScale = v; },
  onRestart: () => {
    timeline.seek(0);
    interactions.clear();
    narration.stop();
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
  activeHistoryEntryId = sessionHistory.recordStart(session.id);

  // Reset pull-model edge detection state
  _lastTextKey = null;
  _wasNarrationPlaying = false;
  _narrationBound = false;
  _completionHandled = false;

  applyTheme(session);

  selector?.dispose?.();
  selector = null;
  hotState.selector = undefined;

  // Wakelock (needs user gesture context from selector click)
  acquireWakeLock();
  registerMediaSession(session.name);
  startSilentAudioKeepAlive();

  // Loading indicator while audio/manifest loads
  const doneLoading = loading.start('preparing session');

  // Wait for audio init AND manifest load before building timeline.
  // The manifest must be loaded so hasStageAudio/getStageAudioDuration return correct values.
  Promise.all([
    audio.init(),
    narration.waitForManifest(),
  ]).then(() => {
    // Build timeline AFTER manifest is available
    timeline.build(
      session.stages,
      (name) => narration.hasStageAudio(name),
      (name) => narration.getStageAudioDuration(name),
    );
    timebar.buildBlocks();
    devMode.rebuildStageButtons();

    // Expose programmatic API on window for AI agents / test harnesses
    hypnoApi = createHypnoAPI({ timeline, machine, interactions, breath, narration, audio, telemetry, bus, canvas, mic, profiler });
    window.__HYPNO__ = hypnoApi;
    wireAssertSubsystems(hypnoApi);

    // Reset telemetry for new session and expose on window
    telemetry.reset();
    (window as any).__HYPNO_TELEMETRY__ = telemetry;

    // Start structured console protocol for AI agent consumption
    initConsoleProtocol(hypnoApi, telemetry);

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
  hypnoApi?._onBackgroundFrame();
}

// ══════════════════════════════════════════════════════════════════════
// SESSION ANIMATION LOOP
// ══════════════════════════════════════════════════════════════════════
function animate(): void {
  if (!isRunning) return;
  hotState.animFrameId = requestAnimationFrame(animate);

  profiler.beginFrame();
  const time = performance.now() / 1000;
  const s = settings.current;

  // ── Pull-model: timeline is the single source of truth ──
  const tlState = timeline.update();
  mic.update();
  profiler.mark('timeline');
  // NOTE: narration.update() is called AFTER block change handling below,
  // so stopStagePlayback() runs before narration can fire stale text events.
  const intensity = intensityOverride ?? (tlState?.intensity ?? 0.12);

  // ── Drive subsystems from block-based TimelineState ──
  if (tlState) {
    // Seek recovery
    if (tlState.seeked) {
      if (tlState.blockJustChanged) {
        // Cross-block seek — full cleanup, block change handler will re-enter
        text3d.clear();
        text3d.clearCue();
        narration.stop();
        narration.stopStagePlayback();
        interactions.clear();
        _lastTextKey = null;
        _wasNarrationPlaying = false;
        _narrationBound = false;
        _lastBreathStage = null;
        if (_breathClip) { _breathClip.pause(); _breathClip = null; }
      } else {
        // Same-block seek — just update text key so text re-derives from position
        _lastTextKey = null;
      }
    }

    // Block change — fire once per transition
    if (tlState.blockJustChanged) {
      const block = tlState.block;
      log.info('block', `Block ${tlState.blockIndex}: ${block.kind} (stage: ${block.stage.name})`, {
        kind: block.kind, stage: block.stage.name, duration: block.duration.toFixed(1),
      });

      text3d.clear();
      text3d.clearCue();
      text3d.clearSlotDepth();
      _lastTextKey = null;
      _narrationBound = false;

      // Narration: enter stage on narration blocks with audio
      if (block.kind === 'narration' && block.narration?.hasAudio) {
        // audioOffset = where in the stage audio this block starts
        // blockElapsed = how far into this block we are (nonzero on seek)
        const offset = (block.narration.audioOffset ?? 0) + tlState.blockElapsed;
        narration.enterStage(block.stage.name, offset);
      } else {
        narration.stopStagePlayback();
      }

      // Breath: apply stage pattern (breathing blocks drive per-frame below)
      if (block.kind !== 'breathing') {
        breath.applyStage(block.stage);
        breath.releaseForce();
      }

      // Audio: update binaural beat intensity
      audio.setIntensity(block.stage.intensity);

      // Breathing: bring presence wisp close + play intro/outro clips
      if (block.kind === 'breathing') {
        presence.transitionTo('breathe', {
          size: 3.0,
          basePos: new THREE.Vector3(0, 0, -1.2),
          duration: 1.0,
        });
        // Play breathing intro/outro audio clips
        if (block.breathing?.phase === 'intro') {
          playBreathClip('breathing_intro');
        } else if (block.breathing?.phase === 'outro') {
          playBreathClip('breathing_good');
        }
      } else {
        presence.setSessionMode();
        // Stop any lingering breath clip when leaving breathing blocks
        if (_breathClip) { _breathClip.pause(); _breathClip = null; }
      }

      setSessionInfo(activeSession?.id ?? '', block.stageIndex);
    }

    // ── Per-frame block-type-specific driving ──

    if (tlState.block.kind === 'breathing' && tlState.breathValue !== null && tlState.breathStage) {
      // Breathing blocks: drive breath controller from position-derived values
      breath.forceValue(tlState.breathValue);
      breath.forceStage(tlState.breathStage);
      text3d.setSlotDepth(-1.2 + tlState.breathValue * 0.7);
      if (tlState.currentText) {
        text3d.showCue(tlState.currentText);
      }

      // Play breathing audio clips on phase change (core blocks only)
      if (tlState.block.breathing?.phase === 'core' && tlState.breathStage !== _lastBreathStage) {
        _lastBreathStage = tlState.breathStage;
        if (tlState.breathStage === 'inhale') playBreathClip('breathe_in');
        else if (tlState.breathStage === 'exhale') playBreathClip('breathe_out');
        else playBreathClip('breathe_hold');
      }
    } else {
      text3d.clearSlotDepth();
      _lastBreathStage = null;
    }

    // Text for narration and interaction blocks
    if (tlState.block.kind === 'narration' || tlState.block.kind === 'interaction') {
      if (tlState.currentText) {
        const textKey = `${tlState.blockIndex}:${tlState.currentText}`;
        if (textKey !== _lastTextKey) {
          _lastTextKey = textKey;
          if (tlState.block.kind === 'narration' && !tlState.block.narration?.hasAudio) {
            narration.speakText(tlState.currentText);
          }
          if (tlState.block.kind === 'interaction') {
            text3d.showInstant(tlState.currentText, 30);
          }
        }
      }
    }

    // Interaction boundary — auto-pause
    if (tlState.atBoundary && !timeline.paused) {
      timeline.pause();
      log.info('interaction', `Paused at boundary: ${tlState.block.interaction?.type}`);
    }

    // Narration stage audio started playing → bind as timeline clock
    if (!_narrationBound && narration.isPlayingStage && narration.stageAudioElement) {
      timeline.bindAudio(narration.stageAudioElement, tlState.block.start);
      _narrationBound = true;
    }

    // Narration stage audio ended → unbind audio clock, fade text
    if (_wasNarrationPlaying && !narration.isPlayingStage) {
      timeline.audioEnded();
      text3d.fadeOut();
      _narrationBound = false;
    }
    _wasNarrationPlaying = narration.isPlayingStage;

    // Isolation boundary — auto-pause when block/stage segment is done
    if (_isolationBoundary !== null && tlState.position >= _isolationBoundary && !_completionHandled) {
      _completionHandled = true;
      timeline.pause();
      log.info('isolation', `Reached boundary at ${_isolationBoundary.toFixed(1)}s — paused`);
      bus.emit('isolation:boundary-reached', { boundary: _isolationBoundary });
    }

    // Completion
    if (tlState.complete && !_completionHandled) {
      _completionHandled = true;
      endExperience();
    }

    // Feed state to public API (event bridge + log buffer)
    hypnoApi?._onFrame(tlState);
  }

  // Narration update AFTER block handling — prevents stale text events
  narration.update();
  profiler.mark('narration');

  // ── Per-frame updates (independent of pull-model) ──
  const micSig = mic.signals;
  if (micSig.active) breath.setFromMic(micSig.breathPhase);
  breath.update(time);
  profiler.mark('breath');

  const audioBands = audio.analyzer?.update() ?? null;
  profiler.mark('audio');

  const rawDt = lastAnimTime > 0 ? time - lastAnimTime : 1 / 60;
  const dt = Math.min(rawDt, 0.1);
  lastAnimTime = time;
  spiralAngle += dt * (tlState?.spiralSpeed ?? 1) * s.spiralSpeedMult * 0.5;

  // Update scene objects
  text3d.setSettings({ startZ: s.narrationStartZ, endZ: s.narrationEndZ, scale: s.narrationScale });
  text3d.update(intensity, breath.phase);
  profiler.mark('text3d');
  interactions.setDepth(s.interactionDepth);
  interactions.setScale(s.interactionScale);
  interactions.update(time, intensity, breath.value);
  profiler.mark('interactions');
  ambient.update();
  profiler.mark('ambient');
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
  profiler.mark('render');
  profiler.endFrame();

  // Telemetry capture (~10fps via internal throttle)
  telemetry.capture({
    timelineState: tlState,
    audioBands,
    breathValue: breath.value,
    breathStage: breath.stage,
    breathCycleDuration: breath.cycleDuration,
    narration: narration.state,
    interactions: {
      breathSyncActive: iState.breathSyncActive,
      breathSyncFill: iState.breathSyncFill,
      humSyncActive: iState.humSyncActive,
      humProgress: iState.humProgress,
    },
    feedbackDisabled: feedback.disabled,
    dt,
    phase: machine.phase,
    epoch: machine.epoch,
    paused: timeline.paused,
  });

  appState.stageIndex = timeline.currentIndex;
  timebar.update();
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

  // Stop timeline and clear all UI
  timeline.stop();
  interactions.clear();
  text3d.clear();
  if (_breathClip) { _breathClip.pause(); _breathClip = null; }
  activeSession = null;

  // Suggest sign-in to anonymous users after session completes
  showPostSessionPrompt();

  bootSelector();
}

function endExperience(): void {
  if (transition.isActive) return;
  if (activeHistoryEntryId) {
    sessionHistory.recordComplete(activeHistoryEntryId, { stagesReached: appState.stageIndex + 1 });
    activeHistoryEntryId = null;
  }
  showText('welcome back');
  machine.transition('ending');
  bus.emit('session:ending', { fadeSec: 3 });
  transition.run(() => cleanupSession(), { fadeOutMs: 3000, holdMs: 500, fadeInMs: 2000 });
}

function returnToMenu(): void {
  if (transition.isActive) return;
  if (activeHistoryEntryId) {
    sessionHistory.recordAbort(activeHistoryEntryId, { stagesReached: appState.stageIndex + 1 });
    activeHistoryEntryId = null;
  }
  machine.transition('ending');
  bus.emit('session:ending', { fadeSec: 1 });
  transition.run(() => cleanupSession(), { fadeOutMs: 1200, holdMs: 300, fadeInMs: 1500 });
}

// ══════════════════════════════════════════════════════════════════════
// ISOLATION MODE — minimal boot paths for testing individual subsystems
// ══════════════════════════════════════════════════════════════════════

function bootIsolation(config: IsolationConfig): void {
  log.info('isolation', `Entering isolation mode: ${config.mode}`, config);

  switch (config.mode) {
    case 'shader':
      bootShaderIsolation(config);
      break;
    case 'block':
    case 'stage':
      bootTimelineIsolation(config);
      break;
    case 'audio':
      bootAudioIsolation(config);
      break;
    case 'interaction':
      bootInteractionIsolation(config);
      break;
  }
}

/** Shader-only mode: render tunnel at fixed/animated params, no timeline */
function bootShaderIsolation(config: ShaderIsolation): void {
  setPhase('session');
  machine.transition('session');
  isRunning = true;

  // If breathPattern is set, drive animated breathing via BreathController
  if (config.breathPattern) {
    breath.setPattern({
      inhale: config.breathPattern.inhale,
      holdIn: config.breathPattern.holdIn ?? 0,
      exhale: config.breathPattern.exhale,
      holdOut: config.breathPattern.holdOut ?? 0,
    });
  }

  // Feedback warp control
  if (!config.feedback) {
    feedback.disabled = true;
  }

  // Presence wisp visibility
  presence.mesh.visible = config.presence;

  // Simulated audio bands (static)
  const simBands = config.bands;

  let shaderIntensity = config.intensity;
  let shaderSpiralSpeed = config.spiralSpeed;

  // Build on-screen sliders for live tweaking
  const panel = buildShaderPanel({
    intensity: shaderIntensity,
    spiralSpeed: shaderSpiralSpeed,
    breath: config.breathPattern ? null : config.breath,
  }, (key, val) => {
    if (key === 'intensity') shaderIntensity = val;
    else if (key === 'spiralSpeed') shaderSpiralSpeed = val;
    else if (key === 'breath') staticBreath = val;
  });
  onCleanup(() => panel.remove());

  let staticBreath = config.breath;

  function animateShader(): void {
    if (!isRunning) return;
    hotState.animFrameId = requestAnimationFrame(animateShader);

    const time = performance.now() / 1000;
    const s = settings.current;
    const rawDt = lastAnimTime > 0 ? time - lastAnimTime : 1 / 60;
    const dt = Math.min(rawDt, 0.1);
    lastAnimTime = time;

    spiralAngle += dt * shaderSpiralSpeed * s.spiralSpeedMult * 0.5;
    breath.update(time);

    // Use animated breath if pattern set, otherwise static value
    const breathVal = config.breathPattern ? breath.value : staticBreath;
    const breathPh = config.breathPattern ? breath.phase : staticBreath;

    const frame: FrameState = {
      time, dt, settings: s,
      breathPhase: breathPh, breathValue: breathVal, breathStage: breath.stage,
      intensity: shaderIntensity, spiralAngle, spiralSpeed: shaderSpiralSpeed,
      mouseX: mouse.x, mouseY: mouse.y,
      audioBands: simBands ? {
        energy: (simBands[0] + simBands[1] + simBands[2]) / 3,
        bass: simBands[0], mid: simBands[1], high: simBands[2],
        spectrum: new Float32Array(0), isPeak: false, voicePresence: 0,
      } : null,
      voiceEnergy: 0, micBoost: 0,
      breathSyncActive: 0, breathSyncFill: 0, breathSyncProgress: 0,
      fadeAmount: 0, intensityMult: 1,
    };
    renderPipeline.renderSession(frame);
    devMode.update();
  }

  animateShader();
}

/** Build a minimal slider panel for shader isolation mode */
function buildShaderPanel(
  defaults: { intensity: number; spiralSpeed: number; breath: number | null },
  onChange: (key: string, val: number) => void,
): HTMLElement {
  const panel = document.createElement('div');
  panel.id = 'isolation-panel';
  panel.style.cssText = 'position:fixed;top:10px;right:10px;background:rgba(0,0,0,0.8);color:#ccc;padding:12px;border-radius:8px;font:12px monospace;z-index:10000;min-width:200px;';

  const title = document.createElement('div');
  title.textContent = 'Shader Isolation';
  title.style.cssText = 'color:#fff;font-weight:bold;margin-bottom:8px;';
  panel.appendChild(title);

  function addSlider(label: string, key: string, min: number, max: number, step: number, initial: number): void {
    const row = document.createElement('div');
    row.style.cssText = 'margin:4px 0;display:flex;align-items:center;gap:6px;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'width:60px;';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    input.style.cssText = 'flex:1;';
    const val = document.createElement('span');
    val.textContent = initial.toFixed(2);
    val.style.cssText = 'width:40px;text-align:right;';
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = v.toFixed(2);
      onChange(key, v);
    });
    row.append(lbl, input, val);
    panel.appendChild(row);
  }

  addSlider('Intensity', 'intensity', 0, 1, 0.01, defaults.intensity);
  addSlider('Spiral', 'spiralSpeed', 0, 5, 0.1, defaults.spiralSpeed);
  if (defaults.breath !== null) {
    addSlider('Breath', 'breath', 0, 1, 0.01, defaults.breath);
  }

  document.body.appendChild(panel);
  return panel;
}

/** Block or stage isolation: load a session, build timeline, play only the target segment */
function bootTimelineIsolation(config: { mode: 'block' | 'stage'; session: string; index?: number; stage?: string }): void {
  const session = getSession(config.session);
  if (!session) {
    log.error('isolation', `Session "${config.session}" not found`);
    bootSelector();
    return;
  }

  activeSession = session;
  setPhase('session');
  machine.transition('session');
  applyTheme(session);

  _lastTextKey = null;
  _wasNarrationPlaying = false;
  _narrationBound = false;
  _completionHandled = false;
  _isolationBoundary = null;

  const doneLoading = loading.start('loading isolation mode');

  Promise.all([
    audio.init(),
    narration.waitForManifest(),
  ]).then(() => {
    if (config.mode === 'stage') {
      // Stage mode: build timeline from just the target stage
      const stageName = config.stage ?? '';
      const targetStage = session.stages.find(s => s.name === stageName);
      if (!targetStage) {
        log.error('isolation', `Stage "${stageName}" not found in session "${config.session}"`);
        doneLoading();
        bootSelector();
        return;
      }
      timeline.build(
        [targetStage],
        (name) => narration.hasStageAudio(name),
        (name) => narration.getStageAudioDuration(name),
      );
      log.info('isolation', `Built single-stage timeline: "${stageName}" (${timeline.blockCount} blocks)`);
    } else {
      // Block mode: build full timeline, will seek to target block
      timeline.build(
        session.stages,
        (name) => narration.hasStageAudio(name),
        (name) => narration.getStageAudioDuration(name),
      );
    }

    timebar.buildBlocks();
    devMode.rebuildStageButtons();

    hypnoApi = createHypnoAPI({ timeline, machine, interactions, breath, narration, audio, telemetry, bus, canvas, mic, profiler });
    window.__HYPNO__ = hypnoApi;
    wireAssertSubsystems(hypnoApi);

    doneLoading();

    if (config.mode === 'block') {
      const idx = config.index ?? 0;
      const block = timeline.allBlocks[idx];
      if (block) {
        // Set boundary at block end so animate() auto-pauses
        _isolationBoundary = block.end;
        timeline.start();
        timeline.seek(block.start);
        log.info('isolation', `Block ${idx}: ${block.kind} [${block.start.toFixed(1)}s–${block.end.toFixed(1)}s]`);
      } else {
        log.error('isolation', `Block index ${idx} out of range (${timeline.blockCount} blocks)`);
        timeline.start();
      }
    } else {
      // Stage mode: timeline is already built from single stage, just start
      timeline.start();
    }

    isRunning = true;
    bus.emit('session:started', { session });
    animate();
  });
}

/** Audio-only isolation: audio engine with DOM control panel */
function bootAudioIsolation(config: { mode: 'audio'; profile: string; component: string }): void {
  const session = getSession(config.profile);
  if (!session) {
    log.error('isolation', `Session/profile "${config.profile}" not found`);
    bootSelector();
    return;
  }

  setPhase('session');
  machine.transition('session');

  audio.init().then(() => {
    audio.start(session.audio);
    audio.setIntensity(0.5);

    if (config.component === 'ambient' || config.component === 'all') {
      ambient.update();
    }

    log.info('isolation', `Audio isolation: profile=${config.profile}, component=${config.component}`);

    // Build DOM control panel
    const panel = buildAudioPanel(config.component, session.audio);
    onCleanup(() => panel.remove());

    // Render a minimal background so the page isn't blank
    animateBackground();
  });
}

/** Build DOM panel for audio isolation with play/pause, volume, and frequency display */
function buildAudioPanel(component: string, profile: import('./session').AudioProfile): HTMLElement {
  const panel = document.createElement('div');
  panel.id = 'isolation-audio-panel';
  panel.style.cssText = 'position:fixed;top:10px;right:10px;background:rgba(0,0,0,0.85);color:#ccc;padding:16px;border-radius:8px;font:12px monospace;z-index:10000;min-width:240px;';

  const title = document.createElement('div');
  title.textContent = `Audio Isolation: ${component}`;
  title.style.cssText = 'color:#fff;font-weight:bold;margin-bottom:10px;';
  panel.appendChild(title);

  // Profile info
  const info = document.createElement('div');
  info.style.cssText = 'margin-bottom:8px;font-size:11px;color:#888;';
  info.innerHTML = `Carrier: ${profile.carrierFreq}Hz | Binaural: ${profile.binauralRange[0]}-${profile.binauralRange[1]}Hz<br>Drone: ${profile.droneFreq}Hz + ${profile.droneFifth}Hz`;
  panel.appendChild(info);

  // Play/Pause button
  const playBtn = document.createElement('button');
  playBtn.textContent = 'Mute';
  playBtn.style.cssText = 'background:#333;color:#fff;border:1px solid #555;padding:6px 16px;border-radius:4px;cursor:pointer;margin-bottom:8px;';
  let muted = false;
  playBtn.addEventListener('click', () => {
    muted = !muted;
    audio.setMuted(muted);
    playBtn.textContent = muted ? 'Unmute' : 'Mute';
  });
  panel.appendChild(playBtn);

  // Volume slider
  const volRow = document.createElement('div');
  volRow.style.cssText = 'margin:6px 0;display:flex;align-items:center;gap:6px;';
  const volLabel = document.createElement('span');
  volLabel.textContent = 'Volume';
  volLabel.style.cssText = 'width:50px;';
  const volSlider = document.createElement('input');
  volSlider.type = 'range';
  volSlider.min = '0';
  volSlider.max = '1';
  volSlider.step = '0.01';
  volSlider.value = '0.5';
  volSlider.style.cssText = 'flex:1;';
  const volVal = document.createElement('span');
  volVal.textContent = '0.50';
  volVal.style.cssText = 'width:35px;text-align:right;';
  volSlider.addEventListener('input', () => {
    const v = parseFloat(volSlider.value);
    volVal.textContent = v.toFixed(2);
    audio.setMasterVolume(v);
  });
  volRow.append(volLabel, volSlider, volVal);
  panel.appendChild(volRow);

  // Intensity slider
  const intRow = document.createElement('div');
  intRow.style.cssText = 'margin:6px 0;display:flex;align-items:center;gap:6px;';
  const intLabel = document.createElement('span');
  intLabel.textContent = 'Intensity';
  intLabel.style.cssText = 'width:50px;';
  const intSlider = document.createElement('input');
  intSlider.type = 'range';
  intSlider.min = '0';
  intSlider.max = '1';
  intSlider.step = '0.01';
  intSlider.value = '0.5';
  intSlider.style.cssText = 'flex:1;';
  const intVal = document.createElement('span');
  intVal.textContent = '0.50';
  intVal.style.cssText = 'width:35px;text-align:right;';
  intSlider.addEventListener('input', () => {
    const v = parseFloat(intSlider.value);
    intVal.textContent = v.toFixed(2);
    audio.setIntensity(v);
  });
  intRow.append(intLabel, intSlider, intVal);
  panel.appendChild(intRow);

  // Frequency analyzer readout (text-based, updated every 500ms)
  const analyzerDiv = document.createElement('div');
  analyzerDiv.style.cssText = 'margin-top:10px;padding:6px;background:#111;border-radius:4px;font-size:11px;line-height:1.4;';
  analyzerDiv.textContent = 'Analyzer: waiting...';
  panel.appendChild(analyzerDiv);

  const updateAnalyzer = setInterval(() => {
    const bands = audio.analyzer?.bands;
    if (bands) {
      const bar = (v: number) => '█'.repeat(Math.round(v * 10)).padEnd(10, '░');
      analyzerDiv.innerHTML =
        `Bass  ${bar(bands.bass)} ${bands.bass.toFixed(2)}<br>` +
        `Mid   ${bar(bands.mid)} ${bands.mid.toFixed(2)}<br>` +
        `High  ${bar(bands.high)} ${bands.high.toFixed(2)}<br>` +
        `<span style="color:#888">Energy: ${bands.energy.toFixed(2)}</span>`;
    }
  }, 200);
  onCleanup(() => clearInterval(updateAnalyzer));

  document.body.appendChild(panel);
  return panel;
}

/** Interaction sandbox: single-block timeline with the requested interaction type */
function bootInteractionIsolation(config: { mode: 'interaction'; type: string; blocking: boolean }): void {
  // Use relax session as base, build a single-stage timeline with the interaction
  const session = getSession('relax');
  if (!session) {
    log.error('isolation', 'Cannot load base session for interaction isolation');
    bootSelector();
    return;
  }

  // Create a synthetic single stage with the requested interaction
  const syntheticStage = {
    ...session.stages[0],
    name: 'interaction-sandbox',
    duration: 60,
    interactions: [{
      type: config.type as 'gate',
      triggerAt: 2,
      duration: 30,
      data: {
        text: `[Isolation] ${config.type} interaction`,
        blocking: config.blocking,
      },
    }],
  };

  activeSession = { ...session, stages: [syntheticStage] };
  setPhase('session');
  machine.transition('session');
  applyTheme(session);

  _lastTextKey = null;
  _wasNarrationPlaying = false;
  _narrationBound = false;
  _completionHandled = false;

  const doneLoading = loading.start('loading interaction sandbox');

  Promise.all([
    audio.init(),
    narration.waitForManifest(),
  ]).then(() => {
    timeline.build(
      activeSession!.stages,
      (name) => narration.hasStageAudio(name),
      (name) => narration.getStageAudioDuration(name),
    );
    timebar.buildBlocks();
    devMode.rebuildStageButtons();

    hypnoApi = createHypnoAPI({ timeline, machine, interactions, breath, narration, audio, telemetry, bus, canvas, mic, profiler });
    window.__HYPNO__ = hypnoApi;
    wireAssertSubsystems(hypnoApi);

    doneLoading();
    isRunning = true;
    timeline.start();
    bus.emit('session:started', { session: activeSession! });
    animate();
  });
}

// ══════════════════════════════════════════════════════════════════════
// STATE-AWARE BOOT — route based on where we are in the experience
// ══════════════════════════════════════════════════════════════════════
function boot(): void {
  // Check for isolation mode BEFORE normal boot path
  const isolation = parseIsolationParams();
  if (isolation && !isHMR) {
    bootIsolation(isolation);
    return;
  }

  const phase = appState.phase;

  // Initialize auth with Supabase client (gracefully degrades if null)
  auth.init(supabase);

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
        // Seek to roughly where we were
        const idx = appState.stageIndex;
        if (idx > 0 && idx < timeline.blockCount) {
          timeline.seek(timeline.allBlocks[idx].start);
        }

        // Re-create API for HMR
        hypnoApi = createHypnoAPI({ timeline, machine, interactions, breath, narration, audio, telemetry, bus, canvas, mic, profiler });
        window.__HYPNO__ = hypnoApi;
        initConsoleProtocol(hypnoApi, telemetry);
        wireAssertSubsystems(hypnoApi);

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

  selector.setFavorites(favorites);

  selector.setExperienceLevelControl((level) => {
    settings.updateBatch({ experienceLevel: level });
  });

  // Auto-sign-in anonymously on first visit (no-op if already authenticated)
  autoAnonymousSignIn();

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
// EXPOSE INITIAL API — minimal surface before session starts
// ══════════════════════════════════════════════════════════════════════
const initialApi = createHypnoAPI({ timeline, machine, interactions, breath, narration, audio, telemetry, bus, canvas, mic, profiler });
window.__HYPNO__ = initialApi;
initConsoleProtocol(initialApi, telemetry);
wireAssertSubsystems(initialApi);
onCleanup(() => teardownConsoleProtocol());

// EXPOSE FRAME PROFILER — accessible via window.__HYPNO_PROFILER__
(window as unknown as Record<string, unknown>).__HYPNO_PROFILER__ = profiler;

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
