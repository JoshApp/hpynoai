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
import tunnelVert from './shaders/tunnel.vert';

function breathStageToFloat(stage: BreathStage): number {
  switch (stage) {
    case 'inhale': return 0;
    case 'hold-in': return 1;
    case 'exhale': return 2;
    case 'hold-out': return 3;
  }
}
import tunnelFrag from './shaders/tunnel.frag';

// ── DOM Elements ──
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const breathGuide = document.getElementById('breath-guide')!;
const breathCircle = document.getElementById('breath-circle')!;

// ── Settings ──
const settings = new SettingsManager();

// ── State ──
const mouse = { x: 0, y: 0 };
let isRunning = false;
let intensityOverride: number | null = null;
let shaderIntensityScale = 1.0;
let activeSession: SessionConfig | null = null;

// ── Three.js Setup ──
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.current.cameraFOV, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = settings.current.cameraZ;

// ── Tunnel Shader ──
const tunnelUniforms = {
  uTime: { value: 0 },
  uIntensity: { value: 0 },
  uMouse: { value: new THREE.Vector2(0, 0) },
  uBreathePhase: { value: 0 },
  uBreathValue: { value: 0 },
  uBreathStage: { value: 0 },
  uSpiralSpeed: { value: 1.0 },
  uTunnelSpeed: { value: 1.0 },
  uTunnelWidth: { value: 1.0 },
  uBreathExpansion: { value: 1.0 },
  uTunnelShape: { value: 0.0 },
  uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
  uColor1: { value: new THREE.Vector3(0.45, 0.1, 0.55) },
  uColor2: { value: new THREE.Vector3(0.7, 0.3, 0.9) },
  uColor3: { value: new THREE.Vector3(0.6, 0.3, 0.8) },
  uColor4: { value: new THREE.Vector3(0.15, 0.02, 0.25) },
  // Audio-reactive uniforms
  uAudioEnergy: { value: 0 },
  uAudioBass: { value: 0 },
  uAudioMid: { value: 0 },
  uAudioHigh: { value: 0 },
  uVoiceEnergy: { value: 0 },
  // Interaction-driven uniforms
  uBreathSyncActive: { value: 0 },
  uBreathSyncFill: { value: 0 },
  uBreathSyncProgress: { value: 0 },
};

const tunnelMaterial = new THREE.ShaderMaterial({
  vertexShader: tunnelVert,
  fragmentShader: tunnelFrag,
  uniforms: tunnelUniforms,
});

const tunnelPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  tunnelMaterial,
);
scene.add(tunnelPlane);

// ── Particles ──
const particles = new ParticleField(500);
scene.add(particles.mesh);

// ── 3D Text ──
const text3d = new Text3D();
scene.add(text3d.mesh);

// ── Audio ──
const audio = new AudioEngine();

// ── Microphone ──
const mic = new MicrophoneEngine();

// ── Breath Controller ──
const breath = new BreathController();
breath.setSimpleCycle(10); // default 10s cycle for entry screen

// ── Narration ──
const narration = new NarrationEngine({
  voiceEnabled: settings.current.ttsEnabled,
  rate: 0.85,
  pitch: 0.9,
  volume: settings.current.narrationVolume,
});
narration.setTextHandler((text) => showText(text));

// ── Text Display — 3D floating words ──
function showText(text: string): void {
  // Update colors from active session theme
  if (activeSession) {
    text3d.setColors(activeSession.theme.textColor, activeSession.theme.textGlow);
  }
  text3d.show(text, 8);
}

// ── Stage Manager ──
const stageManager = new StageManager(
  sessions[0].stages,
  (text) => {
    // Route stage text through narration engine for TTS voicing
    narration.speak(text);
  },
  (stage: SessionStage, _index: number) => {
    console.log(`Stage: ${stage.name}`);
    audio.setIntensity(stage.intensity);

    // Update breath controller from stage config
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

    // Show breathing guide during first stage
    if (_index === 0) {
      breathGuide.classList.add('visible');
    } else if (_index === 1) {
      setTimeout(() => breathGuide.classList.remove('visible'), 5000);
    }
  },
);

// ── Interaction Manager ──
const interactions = new InteractionManager(
  breath,
  scene,
  camera,
  canvas,
  text3d,
);

// Wire mic signals into interactions
interactions.setMicSignals(() => mic.signals);

// Wire interaction triggers — interactions and narration NEVER overlap.
// When an interaction starts, narration pauses and text clears.
// When it ends, narration resumes. One thing at a time.
stageManager.setInteractionHandler(async (interaction: Interaction) => {
  // Clear narration text and pause stage progression
  text3d.clear();
  narration.stop();
  stageManager.pause();

  // Run the interaction (user is fully focused on this)
  await interactions.start(interaction);

  // Resume narration flow
  stageManager.resume();
});

// ── Dev Mode ──
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

// ── Apply Session Theme ──
function applyTheme(session: SessionConfig): void {
  const { theme } = session;

  // Shader colors
  tunnelUniforms.uColor1.value.set(...theme.primaryColor);
  tunnelUniforms.uColor2.value.set(...theme.secondaryColor);
  tunnelUniforms.uColor3.value.set(...theme.accentColor);
  tunnelUniforms.uColor4.value.set(...theme.bgColor);

  // Particle color
  const pMat = particles.mesh.material as THREE.PointsMaterial;
  pMat.color.setRGB(...theme.particleColor);

  // Breathing guide
  breathCircle.style.borderColor = theme.breatheColor;

  // 3D text colors
  text3d.setColors(theme.textColor, theme.textGlow);

  // Tunnel shape (0 = geometric, 1 = organic)
  tunnelUniforms.uTunnelShape.value = theme.tunnelShape ?? 0;
}

// Vignette is now baked into the tunnel shader — no DOM overlay needed

// ── Background visuals during entry ──
function animateBackground(): void {
  if (isRunning) return;
  requestAnimationFrame(animateBackground);

  const time = performance.now() / 1000;
  const s = settings.current;

  breath.update(time);
  tunnelUniforms.uTime.value = time;
  tunnelUniforms.uIntensity.value = 0.12;
  tunnelUniforms.uBreathePhase.value = breath.phase;
  tunnelUniforms.uBreathValue.value = breath.value;
  tunnelUniforms.uBreathStage.value = breathStageToFloat(breath.stage);
  tunnelUniforms.uSpiralSpeed.value = 0.5 * s.spiralSpeedMult;
  tunnelUniforms.uTunnelSpeed.value = s.tunnelSpeed;
  tunnelUniforms.uTunnelWidth.value = s.tunnelWidth;
  tunnelUniforms.uBreathExpansion.value = s.breathExpansion;

  // Apply camera settings in background too
  camera.position.z = s.cameraZ;
  if (camera.fov !== s.cameraFOV) {
    camera.fov = s.cameraFOV;
    camera.updateProjectionMatrix();
  }

  particles.update(0.1, time, s.particleOpacity, s.particleSize);
  if (selector) {
    selector.setDepth(s.menuDepth);
    selector.setScale(s.menuScale);
    selector.update(time);
  }
  if (guidedCal) guidedCal.update(time);
  autoCalibrationFrameHook?.();
  renderer.render(scene, camera);
}

// ── Session Selector ──
function startSession(session: SessionConfig): void {
  activeSession = session;

  stageManager.setStages(session.stages);
  applyTheme(session);
  devMode.rebuildStageButtons();

  document.documentElement.requestFullscreen().catch(() => {});

  // Warm up TTS from user gesture context — Chrome requires this
  narration.warmup();

  // Start audio and mic in parallel
  audio.init().then(() => {
    audio.start(session.audio);
  });
  if (settings.current.micEnabled) {
    mic.start(); // request mic access — gracefully degrades if denied
  }

  // Vignette is now in the tunnel shader — driven by uIntensity + uBreathePhase

  isRunning = true;
  stageManager.start();
  animate();
}

// ── Settings Reactivity ──
settings.onChange((s) => {
  // Audio mute + volume
  audio.setMuted(s.muted);
  audio.setMasterVolume(s.masterVolume);

  // Narration TTS toggle + volume
  narration.setConfig({ voiceEnabled: s.ttsEnabled, volume: s.narrationVolume });
});

// Apply initial mute/volume state (flags are stored even before audio.init)
audio.setMuted(settings.current.muted);
audio.setMasterVolume(settings.current.masterVolume);

// ── Calibration ──
let guidedCal: GuidedCalibration | null = null;

settings.onCalibrate(() => {
  if (guidedCal) return; // already running
  settings.hide();
  if (isRunning) stageManager.pause();

  guidedCal = new GuidedCalibration({ scene, camera, canvas, settings, audio, text3d });
  guidedCal.run().then(() => {
    guidedCal = null;
    if (isRunning) stageManager.resume();
  });
});

// Auto-calibrate on first load (silent, measures FPS for ~2 seconds)
runAutoCalibration(settings);

const selector = new SessionSelector(sessions, startSession, scene, camera, canvas);
animateBackground();

// ── Mouse tracking ──
document.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

// ── Resize ──
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  tunnelUniforms.uResolution.value.set(w, h);
});

// ── Animation Loop ──
function animate(): void {
  if (!isRunning) return;
  requestAnimationFrame(animate);

  const time = performance.now() / 1000;
  const s = settings.current;

  stageManager.update();
  mic.update();
  narration.update();
  const intensity = intensityOverride ?? stageManager.intensity;

  // Breath controller — centralized breath state
  const micSig = mic.signals;
  if (micSig.active) {
    breath.setFromMic(micSig.breathPhase);
  }
  breath.update(time);
  const breathPhase = breath.phase;

  // Update audio analyzer — get frequency bands for reactive visuals
  const analyzer = audio.analyzer;
  let audioBands: AudioBands | null = null;
  if (analyzer) {
    audioBands = analyzer.update();
  }

  // Update shader uniforms
  tunnelUniforms.uTime.value = time;
  tunnelUniforms.uIntensity.value = intensity * shaderIntensityScale;
  tunnelUniforms.uMouse.value.lerp(
    new THREE.Vector2(mouse.x, mouse.y),
    0.02,
  );
  tunnelUniforms.uBreathePhase.value = breathPhase;
  tunnelUniforms.uBreathValue.value = breath.value;
  tunnelUniforms.uBreathStage.value = breathStageToFloat(breath.stage);
  tunnelUniforms.uSpiralSpeed.value = stageManager.spiralSpeed * settings.current.spiralSpeedMult;
  tunnelUniforms.uTunnelSpeed.value = settings.current.tunnelSpeed;
  tunnelUniforms.uTunnelWidth.value = settings.current.tunnelWidth;
  tunnelUniforms.uBreathExpansion.value = settings.current.breathExpansion;

  // Audio-reactive uniforms — WMP tunnel visualizer style
  if (audioBands) {
    tunnelUniforms.uAudioEnergy.value = audioBands.energy;
    tunnelUniforms.uAudioBass.value = audioBands.bass;
    tunnelUniforms.uAudioMid.value = audioBands.mid;
    tunnelUniforms.uAudioHigh.value = audioBands.high;
  }

  // Voice energy from narration (simulated speech rhythm)
  const narrationState = narration.state;
  tunnelUniforms.uVoiceEnergy.value = narrationState.voiceEnergy;

  // Mic-responsive intensity boost: humming intensifies the visual
  let micBoost = 0;
  if (micSig.active && micSig.isHumming) {
    micBoost = micSig.volume * 0.3; // subtle boost when humming
  }
  tunnelUniforms.uIntensity.value += micBoost;

  // Update breathing vignette — the screen itself breathes
  // Update particles (with settings multipliers)
  particles.update(intensity, time, s.particleOpacity, s.particleSize);

  // Update 3D floating text (apply settings for next show() call)
  text3d.setSettings({ startZ: s.narrationStartZ, endZ: s.narrationEndZ, scale: s.narrationScale });
  text3d.update(intensity, breathPhase);

  // Update interactions
  interactions.setDepth(s.interactionDepth);
  interactions.setScale(s.interactionScale);
  const breathValue = Math.sin(breathPhase) * 0.5 + 0.5; // same as shader breathe()
  interactions.update(time, intensity, breathValue);

  // Push interaction shader state
  const iState = interactions.shaderState;
  tunnelUniforms.uBreathSyncActive.value = iState.breathSyncActive;
  tunnelUniforms.uBreathSyncFill.value = iState.breathSyncFill;
  tunnelUniforms.uBreathSyncProgress.value = iState.breathSyncProgress;

  // Apply settings — camera
  camera.position.z = s.cameraZ;
  if (camera.fov !== s.cameraFOV) {
    camera.fov = s.cameraFOV;
    camera.updateProjectionMatrix();
  }

  // Subtle camera sway (scaled by settings)
  camera.position.x = Math.sin(time * 0.1) * 0.02 * intensity * s.cameraSway;
  camera.position.y = Math.cos(time * 0.13) * 0.02 * intensity * s.cameraSway;
  camera.lookAt(0, 0, 0);

  if (guidedCal) guidedCal.update(time);

  renderer.render(scene, camera);

  devMode.update();

  if (stageManager.isComplete) {
    endExperience();
  }
}

// ── End Experience ──
function endExperience(): void {
  isRunning = false;
  audio.fadeOut(6);
  interactions.clear();
  narration.stop();

  showText('welcome back');

  setTimeout(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  }, 8000);
}
