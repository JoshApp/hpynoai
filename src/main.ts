/**
 * HPYNO — main entry point.
 *
 * Creates persistent subsystems (renderer, compositor, audio, presence),
 * assembles the ScreenContext, and boots the ScreenManager.
 * All screen logic lives in src/screens/.
 */

import * as THREE from 'three';
import * as Tone from 'tone';
import { AudioEngine } from './audio';
import { Timeline } from './timeline';
import { Timebar } from './timebar';
import { PlaybackControls } from './playback-controls';
import { DevMode } from './devmode';
import { InteractionManager } from './interactions';
import { sessions } from './sessions/index';
import { MicrophoneEngine } from './microphone';
import { NarrationEngine } from './narration';
import type { SessionConfig } from './session';
import { SettingsManager } from './settings';
import { runAutoCalibration } from './calibration-auto';
import { BreathController } from './breath';
import { Presence } from './presence';
import { hotState, getPersistedRenderer, persistRenderer, onTeardown, runTeardown, nextGeneration, currentGeneration } from './hot-state';
import { appState, setPhase } from './app-state';
import { EventBus } from './events';
import { StateMachine } from './state-machine';
// RenderPipeline removed — screens handle their own render passes
import { InputController } from './input';
import { TransitionManager } from './transition';
import { checkWebGL, installGlobalErrorHandler } from './error-boundary';
import { registerServiceWorker } from './sw-register';
import { log } from './logger';
import { realtimeClock } from './clock';

// Compositor
import {
  Compositor, TunnelLayer, FeedbackLayer, CameraLayer, ParticlesLayer, FadeLayer,
  TextActor, NarrationActor, BreathActor, AudioClipActor, PresenceActor,
  type WorldInputs,
} from './compositor';
import { AudioCompositor } from './audio-compositor';

// Screen system
import { ScreenManager } from './screen-manager';
import type { ScreenContext } from './screen';

// ══════════════════════════════════════════════════════════════════════
// ERROR BOUNDARIES
// ══════════════════════════════════════════════════════════════════════
installGlobalErrorHandler();
registerServiceWorker();
if (!checkWebGL()) throw new Error('WebGL not available');

// ══════════════════════════════════════════════════════════════════════
// HMR TEARDOWN
// ══════════════════════════════════════════════════════════════════════
const isHMR = !!getPersistedRenderer();
runTeardown();
const moduleGen = nextGeneration();

// ══════════════════════════════════════════════════════════════════════
// EVENT BUS + STATE MACHINE
// ══════════════════════════════════════════════════════════════════════
const bus = new EventBus();
const machine = new StateMachine(
  isHMR ? (appState.phase === 'session' ? 'session' : 'boot') : 'boot',
);
machine.setBus(bus);

// ══════════════════════════════════════════════════════════════════════
// DOM
// ══════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('scene') as HTMLCanvasElement;
canvas.style.touchAction = 'none';

// ══════════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════════
const settings = new SettingsManager();
onTeardown(() => settings.destroy());

// Fullscreen toggle
const fsBtn = document.createElement('button');
fsBtn.id = 'fullscreen-btn';
fsBtn.textContent = '\u26F6';
fsBtn.title = 'Toggle fullscreen';
document.getElementById('fullscreen-btn')?.remove();
document.body.appendChild(fsBtn);

function updateFsIcon(): void {
  const doc = document as Document & { webkitFullscreenElement?: Element };
  const isFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  fsBtn.textContent = isFs ? '\u2716' : '\u26F6';
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
onTeardown(() => { fsBtn.remove(); document.removeEventListener('fullscreenchange', updateFsIcon); document.removeEventListener('webkitfullscreenchange', updateFsIcon); });

// ══════════════════════════════════════════════════════════════════════
// THREE.JS CORE
// ══════════════════════════════════════════════════════════════════════
const renderer = getPersistedRenderer() ?? (() => {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true });
  r.setSize(window.innerWidth, window.innerHeight);
  r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  persistRenderer(r);
  return r;
})();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.current.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = settings.current.cameraZ;

const compositeScene = new THREE.Scene();
const compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false }));
compositeScene.add(compositeQuad);
const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const overlayScene = new THREE.Scene();
const transition = new TransitionManager();

// ══════════════════════════════════════════════════════════════════════
// VISUAL COMPOSITOR + LAYERS
// ══════════════════════════════════════════════════════════════════════
const compositor = new Compositor();
onTeardown(() => compositor.dispose());

const tunnelLayer = new TunnelLayer(scene);
compositor.addLayer(tunnelLayer);
const feedbackLayer = new FeedbackLayer(window.innerWidth, window.innerHeight, compositeQuad);
compositor.addLayer(feedbackLayer);
const cameraLayer = new CameraLayer(camera);
compositor.addLayer(cameraLayer);
const particlesLayer = new ParticlesLayer(scene);
compositor.addLayer(particlesLayer);
const fadeLayer = new FadeLayer(overlayScene);
compositor.addLayer(fadeLayer);

// Presence + PresenceActor
const presence = new Presence();
scene.add(presence.mesh);
presence.connectBus(bus);
onTeardown(() => { presence.disconnectBus(); presence.dispose(); });

const presenceActor = new PresenceActor(presence, tunnelLayer);
compositor.addActor(presenceActor);

// ══════════════════════════════════════════════════════════════════════
// AUDIO
// ══════════════════════════════════════════════════════════════════════
const audio = new AudioEngine();
audio.connectBus(bus);
onTeardown(() => audio.dispose());

const audioCompositor = new AudioCompositor();
onTeardown(() => audioCompositor.dispose());

const mic = new MicrophoneEngine();
onTeardown(() => mic.dispose());

// ══════════════════════════════════════════════════════════════════════
// ACTORS + SUBSYSTEMS
// ══════════════════════════════════════════════════════════════════════
const breath = new BreathController();
breath.setSimpleCycle(10);
breath.connectBus(bus);
onTeardown(() => breath.dispose());

const breathActor = new BreathActor(breath);
compositor.addActor(breathActor);

const narration = new NarrationEngine({
  voiceEnabled: settings.current.ttsEnabled,
  rate: 0.85, pitch: 0.9, volume: settings.current.narrationVolume,
});
narration.connectBus(bus);
onTeardown(() => narration.dispose());

const timeline = new Timeline(realtimeClock);
const narrationActor = new NarrationActor(narration, timeline);
compositor.addActor(narrationActor);

const textActor = new TextActor(overlayScene);
compositor.addActor(textActor);

const audioClipActor = new AudioClipActor();
compositor.addActor(audioClipActor);

const text3d = textActor.display; // compat alias

const timebar = new Timebar(timeline);
onTeardown(() => timebar.destroy());

const playbackControls = new PlaybackControls(timeline, settings, audioCompositor);
playbackControls.setNarration(narration);

const interactions = new InteractionManager(breath, overlayScene, camera, canvas, text3d, narration);
interactions.setMicSignals(() => mic.signals);
interactions.setBus(bus);
interactions.setPresenceControl({
  breatheMode: () => presence.transitionTo('breathe', { size: 3.0, basePos: new THREE.Vector3(0, 0, -1.0), duration: 1.5 }),
  sessionMode: () => presence.setSessionMode(),
  getPresence: () => presence,
});

const devMode = new DevMode({
  timeline, audio, interactions,
  getIntensity: () => (timeline.started ? (timeline.currentBlock?.stage.intensity ?? 0.12) : 0.12),
  setIntensityOverride: () => {},
  getShaderIntensityScale: () => 1,
  setShaderIntensityScale: () => {},
  onRestart: () => { timeline.seek(0); interactions.clear(); narration.stop(); },
});
onTeardown(() => devMode.destroy());

// ── HUD — coordinates all overlay UI elements ──
import { HUD } from './hud';
const hud = new HUD({ playbackControls, settings, timebar, devMode, fsBtn });
onTeardown(() => hud.destroy());

// ══════════════════════════════════════════════════════════════════════
// SETTINGS REACTIVITY
// ══════════════════════════════════════════════════════════════════════
settings.onChange((s) => {
  bus.emit('settings:changed', { settings: s });
  audioClipActor.setVolume(s.breathClipVolume);
  audioCompositor.setMasterVolume(s.ambientVolume);
});

if (!isHMR) runAutoCalibration(settings);

// Wire calibrate button → immersive calibration screen (only from menu, not mid-session)
settings.onCalibrate(async () => {
  settings.hide();
  const currentScreen = screenManager.current?.name;
  if (currentScreen === 'session') {
    // Mid-session: don't navigate away, user can use the advanced sliders
    return;
  }
  const { CalibrationScreen } = await import('./screens/calibration');
  screenManager.replace(new CalibrationScreen(), {
    fadeOutMs: 600, holdMs: 200, fadeInMs: 600,
  });
});

// ══════════════════════════════════════════════════════════════════════
// INPUT
// ══════════════════════════════════════════════════════════════════════
const input = new InputController(bus, canvas);
onTeardown(() => input.dispose());

// ══════════════════════════════════════════════════════════════════════
// SCREEN MANAGER — the app's navigation system
// ══════════════════════════════════════════════════════════════════════
const screenCtx: ScreenContext = {
  renderer, scene, overlayScene, camera, compositeScene, compositeCamera, canvas,
  bus, settings, machine, transition,
  compositor, tunnelLayer, feedbackLayer, cameraLayer, particlesLayer,
  textActor, audioClipActor, narrationActor, breathActor, presenceActor,
  audio, audioCompositor, narration, breath,
  presence, timeline, interactions,
  hud, playbackControls, timebar, devMode,
  screenManager: null!, // set by ScreenManager constructor
};

const screenManager = new ScreenManager(screenCtx, transition);

// Exit button on playback controls
playbackControls.onExit(async () => {
  const { SessionSelectorScreen } = await import('./screens/session-selector');
  screenManager.reset(new SessionSelectorScreen({ skipIntro: true }), { fadeOutMs: 1200, holdMs: 300, fadeInMs: 1500 });
});

// ══════════════════════════════════════════════════════════════════════
// RESIZE + VISIBILITY
// ══════════════════════════════════════════════════════════════════════
function handleResize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  tunnelLayer.setResolution(w, h);
  feedbackLayer.resize(w, h);
}
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', () => setTimeout(handleResize, 100));
onTeardown(() => { window.removeEventListener('resize', handleResize); });

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audio.context?.state === 'suspended') {
    audio.context.resume().catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════════════
// RENDER LOOP — rAF, delegates to current screen
// ══════════════════════════════════════════════════════════════════════
let _renderTime = hotState.renderTime;
let _lastRenderTime = 0;

function renderLoop(): void {
  if (currentGeneration() !== moduleGen) return;
  requestAnimationFrame(renderLoop);

  const time = performance.now() / 1000;
  const rawDt = _lastRenderTime > 0 ? time - _lastRenderTime : 1 / 60;
  const dt = Math.min(rawDt, 0.1);
  _lastRenderTime = time;
  _renderTime += dt;

  // Always update the compositor (drives PresenceActor + layer channels)
  const inputs: WorldInputs = {
    timeline: null,
    audioBands: audio.analyzer?.update() ?? null,
    voiceEnergy: narration.state.voiceEnergy,
    breathPhase: breath.phase,
    breathValue: breath.value,
    breathStage: breath.stage,
    micActive: false,
    micBoost: 0,
    interactionShader: interactions.shaderState,
    renderTime: _renderTime,
    dt,
  };
  compositor.update(inputs, dt);

  // Transition manager — must run every frame for screen transitions to work
  transition.update();

  // Screen-specific updates (text, interactions, audio, etc.)
  screenManager.render(time, dt);

  // Always render the 3D world — screens configure it, we draw it
  renderer.setRenderTarget(feedbackLayer.tunnelTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  feedbackLayer.render({
    renderer, scene, overlayScene, camera,
    compositeScene, compositeCamera,
    time: _renderTime, dt,
  });
  renderer.render(compositeScene, compositeCamera);
  renderer.autoClear = false;
  renderer.render(overlayScene, camera);
  renderer.autoClear = true;
}

// ══════════════════════════════════════════════════════════════════════
// BOOT — enter the initial screen
// ══════════════════════════════════════════════════════════════════════
async function boot(): Promise<void> {
  const { SessionSelectorScreen } = await import('./screens/session-selector');
  const { SessionScreen } = await import('./screens/session');

  if (isHMR && appState.phase === 'session') {
    // HMR restore — restart session at saved position
    const savedId = hotState.activeSessionId;
    const session = savedId ? sessions.find(s => s.id === savedId) : null;
    if (session) {
      screenManager.enterImmediate(new SessionScreen(session));
      if (hotState.timelinePosition > 0) {
        timeline.seek(hotState.timelinePosition);
      }
      renderLoop();
      return;
    }
  }

  // Check for saved session progress
  const { loadProgress } = await import('./session-persistence');
  const savedProgress = loadProgress();

  if (savedProgress) {
    // Show resume prompt
    const { ResumePromptScreen } = await import('./screens/resume-prompt');
    screenManager.enterImmediate(new ResumePromptScreen(savedProgress));
  } else {
    // Normal boot — welcome screen (title + onboarding) or selector for returning users
    const { WelcomeScreen } = await import('./screens/welcome');
    screenManager.enterImmediate(new WelcomeScreen());
  }
  renderLoop();
}

boot();

// ══════════════════════════════════════════════════════════════════════
// HMR — snapshot state
// ══════════════════════════════════════════════════════════════════════
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    hotState.isRunning = screenManager.current?.name === 'session';
    hotState.activeSessionId = appState.sessionId ?? null;
    hotState.timelinePosition = timeline.started ? timeline.position : 0;
    hotState.spiralAngle = 0;
    hotState.renderTime = 0;
    hotState.intensityOverride = null;
    hotState.shaderIntensityScale = 1;
    screenManager.dispose();
  });
}
