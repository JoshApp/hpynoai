/**
 * Velvet palette — the shader-side mirror of src/app/tokens.css.
 * Values are 0..1 RGB as consumed directly by the tunnel/wisp shaders.
 */

import type { Preset, TunnelColors, Vec3 } from './types';

export const velvet = {
  bg: [0.027, 0.016, 0.039] as Vec3,
  wineDeep: [0.165, 0.027, 0.078] as Vec3,
  wine: [0.29, 0.059, 0.141] as Vec3,
  plum: [0.22, 0.05, 0.19] as Vec3,
  blush: [1.0, 0.604, 0.659] as Vec3,
  skin: [0.91, 0.702, 0.604] as Vec3,
  silver: [0.914, 0.894, 0.941] as Vec3,
} as const;

export const velvetTunnel: TunnelColors = {
  c1: velvet.wine,
  c2: velvet.plum,
  c3: [0.60, 0.40, 0.36],   // skin glow, dimmed so highlights stay velvet, not pink haze
  c4: velvet.bg,
};

export const wispColors = {
  accent: [0.95, 0.55, 0.62] as Vec3,
  core: velvet.silver,
};

/** Base look of the world when nothing is happening (library, idle). */
export const idlePreset: Preset = {
  tunnel: {
    intensity: 0.14,
    spiralSpeed: 0.3,
    audioReactivity: 0.2,
    colors: velvetTunnel,
    shape: 0.25,
    speed: 0.5,
    width: 1.0,
    breathExpansion: 0.6,
  },
  feedback: { strength: 0.22 },
  camera: { sway: 0.4, fov: 72 },
  particles: { visible: true, intensity: 0.2, color: [0.85, 0.55, 0.6] },
  fade: { opacity: 0 },
};

/** Session look as a function of depth 0..1. */
export function sessionPreset(depth: number): Preset {
  const d = Math.max(0, Math.min(1, depth));
  return {
    tunnel: {
      intensity: 0.15 + d * 0.7,
      spiralSpeed: 0.4 - d * 0.25,
      audioReactivity: 0.4 + d * 0.4,
      colors: velvetTunnel,
      shape: 0.2 + d * 0.15,
      speed: 0.5 - d * 0.2,
      width: 1.0 + d * 0.08,
      breathExpansion: 0.7 + d * 0.5,
    },
    feedback: { strength: 0.2 + d * 0.5 },
    camera: { sway: 0.5 + d * 0.5, fov: 72 },
    particles: { visible: true, intensity: 0.1 + d * 0.35, color: [0.85, 0.55, 0.6] },
    fade: { opacity: 0 },
  };
}
