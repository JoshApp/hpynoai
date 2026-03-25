import * as THREE from 'three';
import * as Tone from 'tone';
import { AudioEngine } from './audio';
import { Timeline, type TimelineState } from './timeline';
import { Timebar } from './timebar';
import { PlaybackControls } from './playback-controls';
import { DevMode } from './devmode';
import { InteractionManager } from './interactions';
import { SessionSelector } from './selector';
import { sessions } from './sessions/index';
import { MicrophoneEngine } from './microphone';
import { NarrationEngine } from './narration';
import type { SessionConfig, SessionStage, Interaction } from './session';
import { SettingsManager } from './settings';
import { runAutoCalibration, autoCalibrationFrameHook } from './calibration-auto';
import { GuidedCalibration } from './calibration-guided';
import { BreathController } from './breath';
// AmbientEngine replaced by AudioCompositor
import { Presence } from './presence';
import { hotState, getPersistedRenderer, persistRenderer, onTeardown, runTeardown, nextGeneration, currentGeneration } from './hot-state';
import { appState, setPhase, setSessionInfo } from './app-state';
import { EventBus } from './events';
import { StateMachine } from './state-machine';
import { acquireWakeLock, releaseWakeLock, registerMediaSession, clearMediaSession, startSilentAudioKeepAlive, stopSilentAudioKeepAlive } from './wakelock';
import { RenderPipeline, type FrameState } from './render-pipeline';
import { InputController } from './input';
import { TransitionManager } from './transition';
// Tunnel shader imports moved to compositor/layers/tunnel.ts
import { checkWebGL, installGlobalErrorHandler } from './error-boundary';
import { registerServiceWorker } from './sw-register';
import { log } from './logger';

// ══════════════════════════════════════════════════════════════════════
// ERROR BOUNDARIES — check before anything else
// ══════════════════════════════════════════════════════════════════════
installGlobalErrorHandler();
registerServiceWorker();
if (!checkWebGL()) throw new Error('WebGL not available');

// ══════════════════════════════════════════════════════════════════════
// HMR TEARDOWN — nuke everything from previous module, then rebuild fresh
// ══════════════════════════════════════════════════════════════════════
const isHMR = !!getPersistedRenderer();
runTeardown();
const moduleGen = nextGeneration(); // stale loops from previous module will see a different gen and bail

// ══════════════════════════════════════════════════════════════════════
// EVENT BUS + STATE MACHINE — fresh every load
// ══════════════════════════════════════════════════════════════════════
const bus = new EventBus();
const machine = new StateMachine(
  isHMR ? (appState.phase === 'session' ? 'session' : 'boot') : 'boot'
);
machine.setBus(bus);

// ══════════════════════════════════════════════════════════════════════
// DOM ELEMENTS
// ══════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('scene') as HTMLCanvasElement;

// ══════════════════════════════════════════════════════════════════════
// SUBSYSTEMS — fresh every load (settings reads from localStorage)
// ══════════════════════════════════════════════════════════════════════
const settings = new SettingsManager();
onTeardown(() => settings.destroy());

const mouse = { x: 0, y: 0 };

// ── Fullscreen toggle button ──
const fsBtn = document.createElement('button');
fsBtn.id = 'fullscreen-btn';
fsBtn.textContent = '\u26F6';
fsBtn.title = 'Toggle fullscreen';
// Remove any stale button from previous HMR
document.getElementById('fullscreen-btn')?.remove();
document.body.appendChild(fsBtn);

function updateFsIcon(): void {
  const doc = document as Document & { webkitFullscreenElement?: Element };
  const isFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  fsBtn.textContent = isFs ? '\u2716' : '\u26F6';
  fsBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
}

const onFsClick = (e: Event) => {
  e.stopPropagation();
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    (doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
  } else {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.())?.catch?.(() => {});
  }
};
fsBtn.addEventListener('click', onFsClick);
document.addEventListener('fullscreenchange', updateFsIcon);
document.addEventListener('webkitfullscreenchange', updateFsIcon);
onTeardown(() => {
  fsBtn.remove();
  document.removeEventListener('fullscreenchange', updateFsIcon);
  document.removeEventListener('webkitfullscreenchange', updateFsIcon);
});

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
let lastAnimTime = 0;
let renderTime = hotState.renderTime ?? 0;  // accumulated shader time (immune to tab-away jumps)
let activeSession: SessionConfig | null = null;

// ── Three.js core — renderer persists (WebGL context is expensive) ──
const renderer = getPersistedRenderer() ?? (() => {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true });
  r.setSize(window.innerWidth, window.innerHeight);
  r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  persistRenderer(r);
  return r;
})();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  settings.current.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100,
);
camera.position.z = settings.current.cameraZ;

const compositeScene = new THREE.Scene();
const compositeQuad = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.MeshBasicMaterial({ map: null, depthTest: false, depthWrite: false }),
);
compositeScene.add(compositeQuad);
const compositeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const overlayScene = new THREE.Scene();


// ── Transition manager (still used for fade-through-black flow) ──
const transition = new TransitionManager();

// ── Compositor — layers + actors ──
import {
  Compositor, TunnelLayer, FeedbackLayer, CameraLayer, ParticlesLayer, FadeLayer,
  TextActor, NarrationActor, BreathActor, AudioClipActor,
  type WorldInputs, type Config,
} from './compositor';

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

// Presence — still using old Presence class for now (complex shader/behavior)
// Will become PresenceActor later
const presence = new Presence();
scene.add(presence.mesh);
presence.connectBus(bus);
onTeardown(() => { presence.disconnectBus(); presence.dispose(); });

// Keep old render pipeline for legacy systems that still need it
// (presence update, background mode). Will be removed incrementally.
const feedback = feedbackLayer.warp;
const renderPipeline = new RenderPipeline({
  renderer, scene, overlayScene, camera,
  tunnelUniforms: tunnelLayer.uniforms,
  feedback, compositeQuad, compositeScene, compositeCamera,
  fadeOverlay: fadeLayer['mesh'],    // FadeLayer owns the mesh now
  gpuParticles: particlesLayer.gpu,
  presence,
});

// ── Audio/mic ──
const audio = new AudioEngine();
audio.connectBus(bus);
onTeardown(() => audio.dispose());

// Audio compositor — replaces old AmbientEngine, takes over binaural/drone/pad/noise/melody
import {
  AudioCompositor, BinauralLayer, DroneLayer, PadLayer, NoiseLayer,
  SubPulseLayer, BreathNoiseLayer, SpatialLayer,
  hashSeed, type AudioPreset,
} from './audio-compositor';

const audioCompositor = new AudioCompositor();
onTeardown(() => audioCompositor.dispose());
// Layers created in startSession() AFTER Tone.setContext() — they must use the shared AudioContext

const mic = new MicrophoneEngine();
onTeardown(() => mic.dispose());

// ── Actors ──
const breath = new BreathController();
breath.setSimpleCycle(10);
breath.connectBus(bus);
onTeardown(() => breath.dispose());

const breathActor = new BreathActor(breath);
compositor.addActor(breathActor);

const narration = new NarrationEngine({
  voiceEnabled: settings.current.ttsEnabled,
  rate: 0.85,
  pitch: 0.9,
  volume: settings.current.narrationVolume,
});
narration.connectBus(bus);
onTeardown(() => narration.dispose());

// NarrationActor created after timeline (below) — needs reference to it

const textActor = new TextActor(overlayScene);
compositor.addActor(textActor);

const audioClipActor = new AudioClipActor();
compositor.addActor(audioClipActor);

// Compat alias — interactions/calibration still reference text3d directly
const text3d = textActor.display;

// ══════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

function applyTheme(session: SessionConfig): void {
  tunnelLayer.applyTheme(session.theme);
  particlesLayer.setColor(...session.theme.particleColor);
  presence.setColors(session.theme.accentColor);
  textActor.setColors(session.theme.textColor, session.theme.textGlow);
}

// ══════════════════════════════════════════════════════════════════════
// TIMELINE — single source of truth for session progression
// ══════════════════════════════════════════════════════════════════════
import { realtimeClock } from './clock';
const timeline = new Timeline(realtimeClock);

// Wire narration actor now that timeline exists
const narrationActor = new NarrationActor(narration, timeline);
compositor.addActor(narrationActor);

let _completionHandled = false;
let _completionWaitStart = 0;
let _lastStageIndex = -1;

// Timebar — dev widget for timeline scrubbing (toggle with T key)
const timebar = new Timebar(timeline);
const playbackControls = new PlaybackControls(timeline, settings, audioCompositor);
playbackControls.setNarration(narration);
onTeardown(() => timebar.destroy());

// ── Stage events driven by pull-model in sessionTick() ──

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
onTeardown(() => interactions.clear());

// Interaction confirm handler — called when user confirms at an interaction boundary
function confirmInteractionBoundary(): void {
  if (!timeline.paused) return;
  // Play gate confirmation sound + silence dip (going deeper feels like a descent)
  try { new Audio('audio/shared/gate_yes.mp3').play().catch(() => {}); } catch {}
  audioCompositor.silenceDip(1.5, 5); // brief silence, slow return = feels like dropping deeper
  timeline.resume();
}

/** Play gate prompt sound when entering an interaction block */
function playGatePrompt(): void {
  try { new Audio('audio/shared/gate_deeper.mp3').play().catch(() => {}); } catch {}
}

// Wire user input to interaction confirmation
bus.on('input:confirm', () => {
  if (timeline.started && timeline.paused) {
    confirmInteractionBoundary();
  }
});

// Narration text is now pull-model: animate loop reads narration.displayLine each frame.

// ── Dev Mode ──
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
onTeardown(() => devMode.destroy());

// ── Settings reactivity ──
// Settings changes → bus. Audio/narration handle themselves.
settings.onChange((s) => {
  bus.emit('settings:changed', { settings: s });
  audioClipActor.setVolume(s.breathClipVolume);
  audioCompositor.setMasterVolume(s.ambientVolume);
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

  // Reset state
  _completionHandled = false;
  _completionWaitStart = 0;

  applyTheme(session);

  selector?.dispose?.();
  selector = null;
  

  // Wakelock (needs user gesture context from selector click)
  acquireWakeLock();
  registerMediaSession(session.name);
  startSilentAudioKeepAlive();


  // Wait for audio init AND manifest load before building timeline.
  Promise.all([
    audio.init(),
    narration.waitForManifest(),
  ]).then(async () => {
    // Audio compositor — transition from menu to session (no stop/dispose, just reconfigure)
    try {
      // Init if not already running from menu
      if (!_menuAudioStarted && audio.masterGainNode) {
        await audioCompositor.init(audio.masterGainNode);
        // Create base layers
        audioCompositor.addLayer(new BinauralLayer());
        audioCompositor.addLayer(new DroneLayer());
        audioCompositor.addLayer(new PadLayer());
        audioCompositor.addLayer(new NoiseLayer());
        audioCompositor.addLayer(new SpatialLayer());

        const { WispAudioLayer } = await import('./audio-compositor/layers/wisp-audio');
        audioCompositor.addLayer(new WispAudioLayer());
        audioCompositor.start();
      }

      // Voice stays direct/center — no spatial processing.
      // The wisp's crystalline tone provides spatial presence.
      // HRTF panning colors the voice too much for clear narration.

      // Add session-only layers if not already present
      if (!audioCompositor.getLayer('sub-pulse')) audioCompositor.addLayer(new SubPulseLayer());
      if (!audioCompositor.getLayer('breath-noise')) audioCompositor.addLayer(new BreathNoiseLayer());

      // Sequencer — addLayer auto-replaces existing 'melody' layer
      const { SequencerActor } = await import('./audio-compositor/actors/sequencer');
      const sequencer = new SequencerActor(hashSeed(session.id));
      const padLayer_ = audioCompositor.getLayer<PadLayer>('pad');
      if (padLayer_) {
        sequencer.onChordChange((chord) => {
          padLayer_.applyPreset({
            ...audioCompositor['currentPreset'],
            pad: { ...audioCompositor['currentPreset'].pad, chord },
          }, 3);
        });
      }
      audioCompositor.addLayer(sequencer);
    } catch (e) {
      log.warn('session', 'Audio compositor setup failed', e);
    }

    // Build audio preset from session config
    const rootNotes: Record<string, number> = { relax: 48, sleep: 45, focus: 52, surrender: 50 };
    const rootNote = rootNotes[session.id] ?? 48;
    const sessionAudioPreset: Partial<AudioPreset> = {
      binaural: {
        carrierFreq: session.audio.carrierFreq,
        beatFreq: session.audio.binauralRange[0],
        volume: settings.current.binauralVolume,
      },
      drone: { rootNote: rootNote - 12, harmonicity: 2, modIndex: 3, volume: 0.15 },
      pad: { chord: [rootNote, rootNote + 4, rootNote + 7, rootNote + 12], filterMax: 1200, warmth: session.audio.warmth, chorusRate: 0.3, volume: 0.2 },
      noise: { type: 'pink', filterFreq: 400, volume: 0.1 },
      melody: { rootNote, volume: 0.12, tempo: 5 },
    };
    // Apply session preset (compositor may already be running from menu)
    if (!audioCompositor['isPlaying']) {
      audioCompositor.start(sessionAudioPreset);
    } else {
      audioCompositor.applyPreset(sessionAudioPreset, 2);
    }
    audioCompositor.setMasterVolume(settings.current.ambientVolume);

    // Build timeline AFTER manifest is available
    timeline.build(
      session.stages,
      (name) => narration.hasStageAudio(name),
      (name) => narration.getStageAudioDuration(name),
    );
    timebar.buildBlocks();
    devMode.rebuildStageButtons();

    isRunning = true;
    machine.transition('session');
    bus.emit('session:started', { session });
    timeline.start();
    startSessionTick();
    playbackControls.activate();
    render();
  });
}

// ══════════════════════════════════════════════════════════════════════
// BACKGROUND ANIMATION (selector screen)
// ══════════════════════════════════════════════════════════════════════
let selector: SessionSelector | null = null;

function animateBackground(): void {
  if (isRunning) return;
  if (currentGeneration() !== moduleGen) return; // stale module — stop
  requestAnimationFrame(animateBackground);

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
// SESSION TICK — always runs (setInterval), drives all state progression
// ══════════════════════════════════════════════════════════════════════
let _tickInterval: ReturnType<typeof setInterval> | null = null;
let _lastTick: TimelineState | null = null;

function sessionTick(): void {
  if (!isRunning) return;

  const tlState = timeline.update();
  _lastTick = tlState;
  if (!tlState) return;

  // Build config from timeline state → compositor handles everything
  const config: Config = {
    preset: {
      tunnel: {
        intensity: tlState.intensity * shaderIntensityScale,
        spiralSpeed: tlState.spiralSpeed,
        audioReactivity: 1,
      },
      feedback: { strength: tlState.intensity },
      camera: { sway: tlState.intensity },
      fade: { opacity: transition.state.fadeAmount },
    },
    actors: [],
  };

  // Narration directive — on block change OR seek (not every tick)
  if (tlState.blockJustChanged || tlState.seeked) {
    if (tlState.wantsNarrationAudio && tlState.narrationStageName) {
      config.actors.push({
        type: 'narration',
        directive: { action: 'play-stage', stageName: tlState.narrationStageName, offset: tlState.narrationAudioOffset + tlState.blockElapsed },
      });
    } else {
      config.actors.push({ type: 'narration', directive: { action: 'stop' } });
    }
  }

  // Breath directive
  if (tlState.breathDrive && tlState.breathValue !== null && tlState.breathStage) {
    config.actors.push({
      type: 'breath',
      directive: { action: 'drive', value: tlState.breathValue, stage: tlState.breathStage },
    });
  } else if (tlState.blockJustChanged) {
    config.actors.push({
      type: 'breath',
      directive: { action: 'apply-stage', stage: tlState.block.stage },
    });
  }

  // Audio clip directive
  if (tlState.audioClip) {
    config.actors.push({ type: 'audio-clip', directive: { clip: tlState.audioClip } });
  } else {
    config.actors.push({ type: 'audio-clip', directive: { clip: null } });
  }

  // Text directive
  const narLine = narration.displayLine;
  if (narLine && narration.isPlayingStage) {
    config.actors.push({
      type: 'text',
      directive: {
        mode: 'focus', text: narLine.text,
        words: narLine.words as Array<{ word: string; start: number; end: number }>,
        audioRef: narration.stageAudioElement, lineStart: narLine.startTime,
      },
    });
  } else if (tlState.text) {
    if (tlState.textStyle === 'cue') {
      config.actors.push({ type: 'text', directive: { mode: 'cue', text: tlState.text, depth: tlState.slotDepth ?? undefined } });
    } else if (tlState.textStyle === 'prompt') {
      config.actors.push({ type: 'text', directive: { mode: 'prompt', text: tlState.text } });
    } else {
      config.actors.push({ type: 'text', directive: { mode: 'narration-tts', text: tlState.text } });
    }
  } else {
    config.actors.push({ type: 'text', directive: { mode: 'clear' } });
  }

  // Stage change OR seek → apply per-stage audio preset to audio compositor
  if (tlState.block.stageIndex !== _lastStageIndex || tlState.seeked) {
    _lastStageIndex = tlState.block.stageIndex;
    const stage = tlState.block.stage;
    const intensity = stage.intensity;

    // Derive audio preset from stage (auto-darkens with depth)
    const stageAudioPreset: Partial<AudioPreset> = {
      binaural: {
        carrierFreq: activeSession?.audio.carrierFreq ?? 120,
        beatFreq: lerp(activeSession?.audio.binauralRange[0] ?? 10, activeSession?.audio.binauralRange[1] ?? 4, intensity),
        volume: settings.current.binauralVolume,
      },
      pad: {
        chord: [stage.breathCycle > 10 ? 48 : 48, 52, 55, 60], // could vary per stage
        filterMax: 1500 - intensity * 900,
        warmth: 0.5 + intensity * 0.4,
        chorusRate: 0.3,
        volume: 0.3 + intensity * 0.15,
      },
      drone: {
        rootNote: 36,
        harmonicity: 2,
        modIndex: 2 + intensity * 4,  // richer harmonics deeper
        volume: 0.2 + intensity * 0.15,
      },
      noise: {
        type: intensity > 0.7 ? 'brown' : 'pink',
        filterFreq: 500 - intensity * 200,
        volume: 0.2 + intensity * 0.25,
      },
      subPulse: {
        frequency: lerp(activeSession?.audio.binauralRange[0] ?? 10, activeSession?.audio.binauralRange[1] ?? 4, intensity),
        depth: 0.2 + intensity * 0.3,
        volume: 0.15 + intensity * 0.1,
      },
      breathNoise: {
        volume: 0.1 + intensity * 0.1,
      },
      melody: {
        rootNote: 48,
        volume: Math.max(0, 0.35 - intensity * 0.4),  // melody fades in deep stages
        tempo: 4 + intensity * 3,                       // slower notes deeper
      },
      reverb: {
        decay: 3 + intensity * 4,   // longer tails deeper
        wet: 0.5 + intensity * 0.25,
      },
    };

    // Apply per-stage override if defined
    if (stage.ambient) {
      // Map old ambient profile fields to new audio preset
      if (stage.ambient.padLevel !== undefined) stageAudioPreset.pad!.volume = stage.ambient.padLevel * 0.4;
      if (stage.ambient.noiseLevel !== undefined) stageAudioPreset.noise!.volume = stage.ambient.noiseLevel * 0.15;
      if (stage.ambient.melodyLevel !== undefined) stageAudioPreset.melody!.volume = stage.ambient.melodyLevel * 0.1;
      if (stage.ambient.filterMax !== undefined) stageAudioPreset.pad!.filterMax = stage.ambient.filterMax;
      if (stage.ambient.warmth !== undefined) stageAudioPreset.pad!.warmth = stage.ambient.warmth;
    }

    audioCompositor.applyPreset(stageAudioPreset, 3);

    // Silence dip on fractionation stages — audio mirrors the visual intensity dip
    if (stage.fractionationDip != null) {
      audioCompositor.silenceDip(2, 6);
    }
  }

  // Interlude — ambient swells, no voice, tunnel calms
  if (tlState.isInterlude && tlState.blockJustChanged) {
    // Swell pad + noise, fade melody, longer reverb tails
    audioCompositor.applyPreset({
      pad: { volume: 0.5, filterMax: 800, warmth: 0.9 } as AudioPreset['pad'],
      noise: { volume: 0.35, filterFreq: 300 } as AudioPreset['noise'],
      melody: { volume: 0 } as AudioPreset['melody'],
      reverb: { decay: 8, wet: 0.7 },
    }, 4); // 4s crossfade into interlude sound
  }

  // Build world inputs
  const micSig = mic.signals;
  const audioBands = audio.analyzer?.update() ?? null;
  const inputs: WorldInputs = {
    timeline: tlState,
    audioBands,
    voiceEnergy: narration.state.voiceEnergy,
    breathPhase: breath.phase,
    breathValue: breath.value,
    breathStage: breath.stage,
    micActive: micSig.active,
    micBoost: micSig.active && micSig.isHumming ? micSig.volume * 0.3 : 0,
    interactionShader: interactions.shaderState,
    renderTime,
    dt: 1 / 60,
  };

  // Visual compositor
  compositor.configure(config);
  compositor.update(inputs, 1 / 60);

  // Audio compositor (breath-reactive layers)
  audioCompositor.update(inputs, 1 / 60);

  // Interaction boundary (transport-level)
  if (tlState.atBoundary && !timeline.paused) {
    timeline.pause();
    playGatePrompt();
  }

  // Completion — retry each tick until transition is free
  if (tlState.complete && !_completionHandled) {
    if (!transition.isActive) {
      _completionHandled = true;
      endExperience();
    } else if (!_completionWaitStart) {
      _completionWaitStart = performance.now();
    } else if (performance.now() - _completionWaitStart > 10000) {
      // Safety: force end if stuck waiting for transition > 10s
      log.warn('session', 'Forced end — transition stuck');
      transition.cancel();
      _completionHandled = true;
      endExperience();
    }
  }
}

function startSessionTick(): void {
  if (_tickInterval) clearInterval(_tickInterval);
  // 60Hz tick — matches rAF cadence when visible, keeps running when hidden
  _tickInterval = setInterval(sessionTick, 1000 / 60);
}

function stopSessionTick(): void {
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
  _lastTick = null;
}
onTeardown(stopSessionTick);

// ══════════════════════════════════════════════════════════════════════
// SESSION RENDER — only when visible (rAF), reads state from last tick
// ══════════════════════════════════════════════════════════════════════
let _renderBlockIndex = -1;

function render(): void {
  if (!isRunning) return;
  if (currentGeneration() !== moduleGen) return; // stale module — stop
  requestAnimationFrame(render);

  const time = performance.now() / 1000;
  const s = settings.current;
  const tlState = _lastTick;
  const intensity = intensityOverride ?? (tlState?.intensity ?? 0.12);

  // Frame timing
  const rawDt = lastAnimTime > 0 ? time - lastAnimTime : 1 / 60;
  const dt = Math.min(rawDt, 0.1);
  lastAnimTime = time;
  renderTime += dt;

  // ── Visual-only: presence (still old system, will become actor later) ──
  if (tlState) {
    // On seek — force text to re-derive (even same position)
    if (tlState.seeked) {
      text3d.reset();
    }

    const renderBlockChanged = tlState.blockIndex !== _renderBlockIndex;
    if (renderBlockChanged) {
      _renderBlockIndex = tlState.blockIndex;
      if (tlState.presenceMode === 'breathe') {
        presence.transitionTo('breathe', { size: 3.0, basePos: new THREE.Vector3(0, 0, -1.2), duration: 1.0 });
      } else {
        presence.setSessionMode();
      }
      setSessionInfo(activeSession?.id ?? '', tlState.block.stageIndex);
    }
  }

  // ── Subsystem updates (visual only) ──
  mic.update();
  const micSig = mic.signals;
  if (micSig.active) breath.setFromMic(micSig.breathPhase);
  breath.update(time);

  textActor.setSettings({ startZ: s.narrationStartZ, endZ: s.narrationEndZ, scale: s.narrationScale });
  tunnelLayer.setSettings({ tunnelSpeed: s.tunnelSpeed, tunnelWidth: s.tunnelWidth, breathExpansion: s.breathExpansion, spiralSpeedMult: s.spiralSpeedMult });
  tunnelLayer.setMouse(mouse.x, mouse.y);
  cameraLayer.setCameraSway(s.cameraSway);

  interactions.setDepth(s.interactionDepth);
  interactions.setScale(s.interactionScale);
  interactions.update(time, intensity, breath.value);
  // Audio compositor update happens in sessionTick, not render
  if (guidedCal) guidedCal.update(time);
  transition.update();
  devMode.update();

  // ── Presence update (still legacy — needs audio/breath/voice) ──
  const audioBands = audio.analyzer?.update() ?? null;
  presence.update(
    renderTime, breath.value, narration.state.voiceEnergy,
    audioBands?.energy ?? 0, audioBands?.bass ?? 0, intensity,
  );
  tunnelLayer.setPresencePos(presence.mesh.position);

  // Feed wisp position to spatial audio (wisp tone + narration voice)
  const wPos = presence.mesh.position;
  const wispAudioLayer = audioCompositor.getLayer('wisp-audio') as import('./audio-compositor/layers/wisp-audio').WispAudioLayer | undefined;
  if (wispAudioLayer) wispAudioLayer.setPosition(wPos.x, wPos.y, wPos.z);
  narration.setSpatialPosition(wPos.x, wPos.y, wPos.z);

  // ── Render passes ──
  // Pass 1: scene (tunnel + particles + presence) → feedback input
  renderer.setRenderTarget(feedbackLayer.tunnelTarget);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);

  // Pass 2: feedback composite
  feedbackLayer.render({ renderer, scene, overlayScene, camera, compositeScene, compositeCamera, time: renderTime, dt });
  renderer.render(compositeScene, compositeCamera);

  // Pass 3: overlay (text, interactions, fade — sharp, no blur)
  renderer.autoClear = false;
  renderer.render(overlayScene, camera);
  renderer.autoClear = true;

  appState.stageIndex = timeline.currentIndex;
  timebar.update();
  playbackControls.update();
}

// ══════════════════════════════════════════════════════════════════════
// END EXPERIENCE — fade through tunnel, return to selector
// ══════════════════════════════════════════════════════════════════════
/** Shared cleanup for any session → selector transition */
function cleanupSession(): void {
  log.info('session', 'cleanupSession START');
  sessionEpoch++;
  isRunning = false;
  setPhase('selector');
  machine.transition('selector');
  bus.emit('session:ended', {});

  playbackControls.deactivate();

  // Release platform locks
  releaseWakeLock();
  clearMediaSession();
  stopSilentAudioKeepAlive();

  // Stop tick + timeline + audio
  stopSessionTick();
  audioCompositor.stop();
  _menuAudioStarted = false; // allow menu audio to restart on next gesture
  timeline.stop();
  interactions.clear();
  text3d.clear();
  audioClipActor.deactivate();
  activeSession = null;

  log.info('session', 'cleanupSession — calling bootSelector');
  bootSelector(true); // skip intro, go straight to carousel
  log.info('session', 'cleanupSession DONE');
}

function endExperience(): void {
  if (transition.isActive) return;
  log.info('session', 'endExperience — starting fade');
  text3d.set('welcome back', 'narration');
  machine.transition('ending');
  bus.emit('session:ending', { fadeSec: 3 });
  audioCompositor.resolve();
  try { playClosingTone(); } catch (e) { log.warn('session', 'closing tone failed', e); }
  transition.run(() => {
    log.info('session', 'endExperience — midpoint, calling cleanupSession');
    cleanupSession();
    log.info('session', 'endExperience — cleanupSession done, bootSelector started');
  }, { fadeOutMs: 3000, holdMs: 500, fadeInMs: 2000 });
}

/** Warm descending tone — like a gentle bell settling */
function playClosingTone(): void {
  try {
    const now = Tone.now();
    const synth = new Tone.FMSynth({
      harmonicity: 2, modulationIndex: 3,
      envelope: { attack: 0.5, decay: 1, sustain: 0.3, release: 6 },
      modulationEnvelope: { attack: 0.3, decay: 0.5, sustain: 0.2, release: 4 },
    });
    const gain = new Tone.Gain(0.1);
    const reverb = new Tone.Reverb({ decay: 7, wet: 0.85 });

    synth.connect(gain);
    gain.connect(reverb);
    if (audio.masterGainNode) Tone.connect(reverb, audio.masterGainNode);

    // Descending: high → warm resolution
    synth.triggerAttackRelease('G5', 2, now);
    synth.triggerAttackRelease('E4', 3, now + 0.8);
    synth.triggerAttackRelease('C4', 4, now + 1.5);

    setTimeout(() => { synth.dispose(); gain.dispose(); reverb.dispose(); }, 12000);
  } catch { /* audio not ready */ }
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
      // Mid-session HMR — restore session from hotState, rebuild, seek
      const savedId = hotState.activeSessionId;
      const savedPos = hotState.timelinePosition;
      const session = savedId ? sessions.find(s => s.id === savedId) : null;

      if (session) {
        // Full session restart with position restoration
        activeSession = session;
        applyTheme(session);
        bus.emit('session:starting', { session });

        narration.clearManifest();
        narration.loadManifest(`audio/${session.id}/manifest.json`).catch(() => {});

        Promise.all([
          audio.init(),
          narration.waitForManifest(),
        ]).then(async () => {
          if (audio.masterGainNode) {
            try { await audioCompositor.init(audio.masterGainNode); } catch { /* ok */ }
          }
          timeline.build(
            session.stages,
            (name) => narration.hasStageAudio(name),
            (name) => narration.getStageAudioDuration(name),
          );
          timebar.buildBlocks();
          devMode.rebuildStageButtons();
          timeline.start();
          if (savedPos > 0) timeline.seek(savedPos);

          isRunning = true;
          machine.transition('session');
          bus.emit('session:started', { session });
          startSessionTick();
          render();
          log.info('hmr', `Restored session "${session.id}" at ${savedPos.toFixed(1)}s`);
        });
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

let _menuAudioStarted = false;

/** Start subtle ambient audio on the menu screen (called on first user gesture) */
async function startMenuAudio(): Promise<void> {
  log.info('audio', `startMenuAudio called, already started=${_menuAudioStarted}`);
  if (_menuAudioStarted) return;
  _menuAudioStarted = true;

  try {
    await audio.init();
    if (!audio.masterGainNode) return;
    await audioCompositor.init(audio.masterGainNode);

    // Menu layers — pad + drone + wisp audio
    audioCompositor.addLayer(new BinauralLayer());
    audioCompositor.addLayer(new DroneLayer());
    audioCompositor.addLayer(new PadLayer());
    audioCompositor.addLayer(new NoiseLayer());
    audioCompositor.addLayer(new SpatialLayer());

    const { WispAudioLayer } = await import('./audio-compositor/layers/wisp-audio');
    const wispAudio = new WispAudioLayer();
    audioCompositor.addLayer(wispAudio);

    audioCompositor.setMasterVolume(settings.current.ambientVolume);
    audioCompositor.start({
      binaural: { carrierFreq: 120, beatFreq: 10, volume: 0.15 },
      drone: { rootNote: 36, harmonicity: 2, modIndex: 2, volume: 0.1 },
      pad: { chord: [48, 52, 55, 60], filterMax: 800, warmth: 0.5, chorusRate: 0.2, volume: 0.12 },
      noise: { type: 'pink', filterFreq: 300, volume: 0.05 },
      spatial: { rate: 0.05, depth: 0.3 },
      melody: { rootNote: 48, volume: 0, tempo: 0 },
    } as Partial<AudioPreset>);

    playOpeningTone();

    // After chime settles, fade layers to whisper (menu shouldn't drone)
    setTimeout(() => {
      if (_menuAudioStarted && !isRunning) {
        audioCompositor.applyPreset({
          pad: { chord: [48, 52, 55, 60], filterMax: 400, warmth: 0.5, chorusRate: 0.2, volume: 0.03 },
          drone: { rootNote: 36, harmonicity: 2, modIndex: 1, volume: 0.02 },
          noise: { type: 'pink', filterFreq: 200, volume: 0.01 },
          binaural: { carrierFreq: 120, beatFreq: 10, volume: 0.03 },
        } as Partial<AudioPreset>, 6);
      }
    }, 8000);

    log.info('audio', 'Menu ambient started');
  } catch (e) {
    log.warn('audio', 'Menu audio failed', e);
  }
}

/** Ethereal rising tone on app start — like a crystal instrument powering on */
/**
 * HPYNO startup chime — recognizable 3-second signature sound.
 *
 * Structure:
 * 1. Deep sub hit (felt, not heard) — something awakens
 * 2. Rising harmonic sweep — energy building
 * 3. Crystalline chord bloom — the space opens
 * 4. Long reverb tail — settles into the ambient
 */
function playOpeningTone(): void {
  try {
    const now = Tone.now();
    const nodes: Tone.ToneAudioNode[] = [];

    // Master chain for the chime
    const gain = new Tone.Gain(0.2);
    const reverb = new Tone.Reverb({ decay: 6, wet: 0.75, preDelay: 0.03 });
    const filter = new Tone.Filter({ frequency: 100, type: 'lowpass', Q: 3, rolloff: -24 });
    filter.connect(gain);
    gain.connect(reverb);
    if (audio.masterGainNode) Tone.connect(reverb, audio.masterGainNode);
    nodes.push(gain, reverb, filter);

    // Phase 1: Sub hit (0s) — deep body thud
    const sub = new Tone.Oscillator({ type: 'sine', frequency: 40 });
    const subGain = new Tone.Gain(0);
    sub.connect(subGain);
    subGain.connect(filter);
    subGain.gain.setValueAtTime(0, now);
    subGain.gain.linearRampToValueAtTime(0.4, now + 0.05);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
    sub.start(now);
    sub.stop(now + 2);
    nodes.push(sub, subGain);

    // Phase 2: Rising sweep (0.2s) — harmonic ascent
    const sweep = new Tone.FMSynth({
      harmonicity: 3, modulationIndex: 10,
      oscillator: { type: 'sine' },
      modulation: { type: 'sine' },
      envelope: { attack: 0.8, decay: 0.3, sustain: 0.2, release: 2 },
      modulationEnvelope: { attack: 0.5, decay: 0.2, sustain: 0.1, release: 1.5 },
    });
    sweep.volume.value = -8;
    sweep.connect(filter);
    sweep.triggerAttackRelease('C3', 2, now + 0.1);
    // Sweep the mod index for movement
    sweep.modulationIndex.setValueAtTime(1, now + 0.1);
    sweep.modulationIndex.rampTo(12, 1.5);
    sweep.modulationIndex.rampTo(2, 1);
    nodes.push(sweep);

    // Filter opens with the sweep
    filter.frequency.setValueAtTime(100, now);
    filter.frequency.exponentialRampToValueAtTime(3000, now + 1.5);
    filter.frequency.rampTo(800, 2);

    // Phase 3: Crystalline chord bloom (0.8s) — the signature moment
    const bell1 = new Tone.FMSynth({
      harmonicity: 5, modulationIndex: 6,
      envelope: { attack: 0.1, decay: 0.3, sustain: 0.4, release: 4 },
      modulationEnvelope: { attack: 0.05, decay: 0.2, sustain: 0.3, release: 3 },
    });
    const bell2 = new Tone.FMSynth({
      harmonicity: 7, modulationIndex: 4,
      envelope: { attack: 0.15, decay: 0.3, sustain: 0.3, release: 5 },
      modulationEnvelope: { attack: 0.08, decay: 0.2, sustain: 0.2, release: 3 },
    });
    const bell3 = new Tone.FMSynth({
      harmonicity: 3, modulationIndex: 5,
      envelope: { attack: 0.2, decay: 0.4, sustain: 0.3, release: 4 },
      modulationEnvelope: { attack: 0.1, decay: 0.2, sustain: 0.2, release: 3 },
    });
    bell1.volume.value = -10;
    bell2.volume.value = -12;
    bell3.volume.value = -11;
    bell1.connect(filter);
    bell2.connect(filter);
    bell3.connect(filter);
    nodes.push(bell1, bell2, bell3);

    // The chord: C5 - G5 - E6 — bright, open, ascending
    bell1.triggerAttackRelease('C5', 3, now + 0.8);
    bell2.triggerAttackRelease('G5', 2.5, now + 1.0);
    bell3.triggerAttackRelease('E6', 2, now + 1.2);

    // Phase 4: Final shimmer ping (1.8s) — the "dot" at the end
    const ping = new Tone.FMSynth({
      harmonicity: 8, modulationIndex: 12,
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.1, release: 3 },
      modulationEnvelope: { attack: 0.01, decay: 0.05, sustain: 0.05, release: 2 },
    });
    ping.volume.value = -14;
    ping.connect(filter);
    ping.triggerAttackRelease('C7', 0.5, now + 1.8);
    nodes.push(ping);

    // Cleanup after everything fades
    setTimeout(() => { for (const n of nodes) n.dispose(); }, 12000);
  } catch { /* audio not ready */ }
}


// Start menu audio on first click/tap/key anywhere
const startMenuOnGesture = () => {
  startMenuAudio();
  document.removeEventListener('click', startMenuOnGesture);
  document.removeEventListener('keydown', startMenuOnGesture);
  document.removeEventListener('touchstart', startMenuOnGesture);
};
document.addEventListener('click', startMenuOnGesture);
document.addEventListener('keydown', startMenuOnGesture);
document.addEventListener('touchstart', startMenuOnGesture);
onTeardown(() => {
  document.removeEventListener('click', startMenuOnGesture);
  document.removeEventListener('keydown', startMenuOnGesture);
  document.removeEventListener('touchstart', startMenuOnGesture);
});

function bootSelector(skipIntro = false): void {
  setPhase('selector');
  isRunning = false;

  selector = new SessionSelector(sessions, startSession, overlayScene, camera, canvas, bus, skipIntro);

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

  // Audio preview — shift ambient soundscape toward the hovered session's character
  // Audio preview — swell on hover with session flavor, fade back after
  let _previewFadeTimer: number | null = null;

  selector.setAudioPreview((session) => {
    if (!_menuAudioStarted) return;
    if (_previewFadeTimer) { clearTimeout(_previewFadeTimer); _previewFadeTimer = null; }

    const rootNotes: Record<string, number> = { relax: 48, sleep: 45, focus: 52, surrender: 50 };
    const root = rootNotes[session.id] ?? 48;

    // Swell with session's sonic character
    audioCompositor.applyPreset({
      binaural: { carrierFreq: session.audio.carrierFreq, beatFreq: session.audio.binauralRange[0], volume: 0.15 },
      drone: { rootNote: root - 12, harmonicity: 2, modIndex: 2, volume: 0.1 },
      pad: { chord: [root, root + 4, root + 7, root + 12], filterMax: 800, warmth: session.audio.warmth, chorusRate: 0.2, volume: 0.12 },
      noise: { type: session.audio.warmth > 0.7 ? 'brown' : 'pink', filterFreq: 300, volume: 0.05 },
    } as Partial<AudioPreset>, 1.5);

    // Fade layers back to whisper after 4s
    _previewFadeTimer = window.setTimeout(() => {
      if (_menuAudioStarted && !isRunning) {
        audioCompositor.applyPreset({
          pad: { chord: [48, 52, 55, 60], filterMax: 400, warmth: 0.5, chorusRate: 0.2, volume: 0.03 },
          drone: { rootNote: 36, harmonicity: 2, modIndex: 1, volume: 0.02 },
          noise: { type: 'pink', filterFreq: 200, volume: 0.01 },
          binaural: { carrierFreq: 120, beatFreq: 10, volume: 0.03 },
        } as Partial<AudioPreset>, 3);
      }
    }, 4000);
  });

  // Restart menu ambient (AudioContext is already unlocked from the session)
  startMenuAudio();

  animateBackground();
}

// ══════════════════════════════════════════════════════════════════════
// INPUT CONTROLLER — centralized input, emits semantic events on bus
// ══════════════════════════════════════════════════════════════════════

const input = new InputController(bus, canvas);
onTeardown(() => input.dispose());

// Pointer-move disabled — tunnel stays centered for focused immersion

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
  tunnelLayer.setResolution(w, h);
  feedback.resize(w, h);
}
window.addEventListener('resize', handleResize);
const onOrientationChange = () => setTimeout(handleResize, 100);
window.addEventListener('orientationchange', onOrientationChange);
onTeardown(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('orientationchange', onOrientationChange);
});

// ══════════════════════════════════════════════════════════════════════
// VISIBILITY — handle tab away / tab back gracefully
// ══════════════════════════════════════════════════════════════════════
const onVisibilityChange = () => {
  if (document.hidden) {
    log.info('visibility', 'Tab hidden — tick continues running');
    // Tick keeps running via setInterval (not rAF), so timeline advances.
    // rAF render() will stop and resume automatically.
  } else {
    lastAnimTime = 0; // prevent huge dt spike on resume
    log.info('visibility', `Tab resumed, position: ${timeline.position.toFixed(1)}s`);
    if (audio.context?.state === 'suspended') {
      audio.context.resume().catch(() => {});
    }
  }
};
document.addEventListener('visibilitychange', onVisibilityChange);
onTeardown(() => document.removeEventListener('visibilitychange', onVisibilityChange));

// ══════════════════════════════════════════════════════════════════════
// GO
// ══════════════════════════════════════════════════════════════════════
boot();

// ══════════════════════════════════════════════════════════════════════
// HMR — snapshot scalars, then teardown runs at top of next module load
// ══════════════════════════════════════════════════════════════════════
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    // Snapshot position + state for restoration
    hotState.isRunning = isRunning;
    hotState.activeSessionId = activeSession?.id ?? null;
    hotState.timelinePosition = timeline.started ? timeline.position : 0;
    hotState.spiralAngle = spiralAngle;
    hotState.renderTime = renderTime;
    hotState.intensityOverride = intensityOverride;
    hotState.shaderIntensityScale = shaderIntensityScale;

    // Stop animation frames and tick interval
    stopSessionTick();
    // Teardown registered cleanup functions (called at top of next load via runTeardown)
  });
}
