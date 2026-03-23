/**
 * Shared sprite factory — single source of truth for canvas-textured sprites.
 *
 * Used by Text3D, SessionSelector, InteractionManager, and GuidedCalibration.
 * Eliminates ~150 lines of duplicated canvas rendering code.
 */

import * as THREE from 'three';

// ── Shared constants ──
export const TEXT_FONT_FAMILY = 'Georgia, serif';
export const TEXT_FONT_WEIGHT = '300';

export interface TextSpriteOpts {
  fontSize?: number;
  color?: string;
  glow?: string;
  /** Device pixel ratio multiplier for hi-dpi (default 1) */
  dpr?: number;
  /** Initial opacity (default 0) */
  opacity?: number;
  /** Outline stroke width (default 3, scaled by dpr) */
  outlineWidth?: number;
  /** Shadow blur radius (default 20, scaled by dpr) */
  glowBlur?: number;
  /** Whether to double-fill for extra glow intensity (default true) */
  doubleFill?: boolean;
  /** Whether to draw dark outline for contrast (default true) */
  outline?: boolean;
}

/**
 * Create a text sprite with consistent styling across the app.
 * Returns sprite + canvas/ctx/texture for callers that need to redraw (karaoke).
 */
export function createTextSprite(
  text: string,
  opts: TextSpriteOpts = {},
): THREE.Sprite {
  const {
    fontSize = 48,
    color = '#c8a0ff',
    glow = 'rgba(200, 160, 255, 0.4)',
    dpr = 1,
    opacity = 0,
    outlineWidth = 3,
    glowBlur = 20,
    doubleFill = true,
    outline = true,
  } = opts;

  const scaledSize = fontSize * dpr;
  const font = `${TEXT_FONT_WEIGHT} ${scaledSize}px ${TEXT_FONT_FAMILY}`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;

  const metrics = ctx.measureText(text || 'M');
  const pad = scaledSize * 0.8;
  canvas.width = Math.ceil(metrics.width + pad * 2);
  canvas.height = Math.ceil(scaledSize * 2 + pad * 2);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Dark outline for contrast against tunnel
  if (outline) {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = outlineWidth * dpr;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, cx, cy);
  }

  // Glow + fill
  ctx.shadowColor = glow;
  ctx.shadowBlur = glowBlur * dpr;
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
  if (doubleFill) {
    ctx.fillText(text, cx, cy);
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  const sprite = new THREE.Sprite(material);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(0.5 * aspect, 0.5, 1);

  return sprite;
}

/**
 * Create a glowing orb sprite with radial gradient.
 */
export function createOrbSprite(
  r: number, g: number, b: number,
  opts: { dpr?: number; size?: number } = {},
): THREE.Sprite {
  const dpr = opts.dpr ?? 1;
  const size = Math.round((opts.size ?? 256) * dpr);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const cx = size / 2;
  const orbR = size * 0.3;
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);

  const gradient = ctx.createRadialGradient(cx, cx * 0.75, 0, cx, cx * 0.75, orbR);
  gradient.addColorStop(0, `rgba(${R}, ${G}, ${B}, 1.0)`);
  gradient.addColorStop(0.2, `rgba(${R}, ${G}, ${B}, 0.6)`);
  gradient.addColorStop(0.5, `rgba(${R}, ${G}, ${B}, 0.2)`);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  return new THREE.Sprite(material);
}

/**
 * Create a canvas + ctx pair for dynamic redrawing (karaoke text, QTE rings).
 * Returns the canvas, ctx, texture, and a sprite already configured.
 */
export function createDynamicSprite(
  width: number,
  height: number,
  opts: { opacity?: number } = {},
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  sprite: THREE.Sprite;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: opts.opacity ?? 1,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  const sprite = new THREE.Sprite(material);
  const aspect = width / height;
  sprite.scale.set(0.5 * aspect, 0.5, 1);

  return { canvas, ctx, texture, sprite };
}
