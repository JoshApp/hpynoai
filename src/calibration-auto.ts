/**
 * Silent auto-calibration — runs once on first load.
 * Measures GPU performance (FPS) and screen geometry,
 * then writes optimized defaults into SettingsManager.
 */

import type { SettingsManager, HpynoSettings } from './settings';

// Bump version to force re-calibration when sprite/text system changes
const CALIBRATED_KEY = 'hpyno-calibrated-v2';
const WARMUP_FRAMES = 30;
const MEASURE_FRAMES = 90;
const TOTAL_FRAMES = WARMUP_FRAMES + MEASURE_FRAMES;

/** Hook called from animateBackground each frame during measurement */
export let autoCalibrationFrameHook: (() => void) | null = null;

export function runAutoCalibration(settings: SettingsManager): Promise<void> {
  return new Promise((resolve) => {
    if (localStorage.getItem(CALIBRATED_KEY) === 'true') {
      resolve();
      return;
    }

    const frameTimes: number[] = [];
    let lastTime = performance.now();
    let frameCount = 0;

    autoCalibrationFrameHook = () => {
      const now = performance.now();
      frameCount++;

      // Skip warmup frames (shader compilation, initial load)
      if (frameCount > WARMUP_FRAMES) {
        frameTimes.push(now - lastTime);
      }
      lastTime = now;

      if (frameCount >= TOTAL_FRAMES) {
        autoCalibrationFrameHook = null;
        const changes = computeSettings(frameTimes);
        settings.updateBatch(changes);
        localStorage.setItem(CALIBRATED_KEY, 'true');
        console.log('[AutoCal] Calibration complete', changes);
        resolve();
      }
    };
  });
}

/** Clear the calibration flag so it re-runs on next load */
export function resetAutoCalibration(): void {
  localStorage.removeItem(CALIBRATED_KEY);
}

function computeSettings(frameTimes: number[]): Partial<HpynoSettings> {
  // Median FPS (more robust than average against GC spikes)
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  const fps = 1000 / medianMs;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio;
  const effectivePx = w * dpr;
  const isMobile = w < 768;

  console.log(`[AutoCal] Median FPS: ${fps.toFixed(1)}, Screen: ${w}x${h} @${dpr}x, Mobile: ${isMobile}`);

  const changes: Partial<HpynoSettings> = {};

  // ── Performance tier ──
  if (fps < 35) {
    // Low-end — reduce visual load
    changes.particleOpacity = 0.4;
    changes.particleSize = 0.5;
    changes.tunnelSpeed = 0.8;
    changes.cameraSway = 0.5;
  } else if (fps < 55) {
    // Mid-range — slight reduction
    changes.particleOpacity = 0.7;
    changes.particleSize = 0.8;
  }
  // High (55+): keep defaults

  // ── Screen scale — proportional to screen real estate ──
  // Reference: 1920×1080 @1x = 1920 effective px → scale 1.0
  const referencePx = 1920;
  const screenScale = Math.max(0.6, Math.min(2.5, effectivePx / referencePx));

  if (isMobile) {
    // Mobile: shallower depths, larger relative text, closer to camera
    changes.narrationScale = 1.6 * screenScale;
    changes.menuScale = 2.5 * screenScale;
    changes.interactionScale = 1.5 * screenScale;
    changes.narrationStartZ = -1.4;
    changes.narrationEndZ = -0.5;
    changes.menuDepth = -1.2;
    changes.interactionDepth = -0.9;
  } else {
    // Desktop: scale proportionally, cap narration to avoid edge clipping
    const narrationMult = Math.min(1.4 * screenScale, 2.2);
    changes.narrationScale = narrationMult;
    changes.menuScale = 2.5 * screenScale;
    changes.interactionScale = 1.3 * screenScale;
    changes.narrationStartZ = -1.8;
    changes.narrationEndZ = -0.55;
    changes.menuDepth = -1.5;
    changes.interactionDepth = -1.2;
  }

  console.log(`[AutoCal] Screen scale factor: ${screenScale.toFixed(2)} (${effectivePx}px effective)`);

  // ── Aspect ratio adjustments ──
  const aspect = w / h;
  if (aspect > 2) {
    // Ultra-wide: widen FOV
    changes.cameraFOV = 85;
  } else if (aspect < 1) {
    // Portrait (phone): narrow FOV, closer depths
    changes.cameraFOV = 65;
    changes.menuDepth = -1.0;
  }

  return changes;
}
