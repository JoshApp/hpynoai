import * as THREE from 'three';

/**
 * SpriteText — the one text rendering system for HPYNO.
 *
 * Rules:
 *   1. Canvas renders at fontSize * DPR — always crisp
 *   2. Canvas size = exactly what the text needs (measured)
 *   3. Sprite world-height = the `height` param (3D units)
 *   4. Sprite world-width = height * aspect — never squashed
 *   5. Never set scale manually after creation
 *
 * Usage:
 *   const sprite = SpriteText.create('hello world', {
 *     height: 0.08,          // world-space height in 3D units
 *     fontSize: 48,          // logical font size (before DPR scaling)
 *     color: '#c8a0ff',
 *     glow: 'rgba(200,160,255,0.4)',
 *     weight: 300,
 *     font: 'Georgia, serif',
 *   });
 *   scene.add(sprite);
 */

export interface SpriteTextOptions {
  /** Height of the text in 3D world units. Width is derived from aspect ratio. */
  height: number;
  /** Logical font size in px (will be multiplied by DPR internally). Default: 48 */
  fontSize?: number;
  /** CSS color string. Default: '#ffffff' */
  color?: string;
  /** CSS glow color string (used for shadowColor). Default: transparent */
  glow?: string;
  /** Font weight. Default: 300 */
  weight?: number;
  /** Font family. Default: 'Georgia, serif' */
  font?: string;
  /** Whether to use additive blending. Default: true */
  /** Whether to use additive blending. Default: true */
  additive?: boolean;
  /** Outline thickness multiplier (0 = no outline). Default: 1 */
  outline?: number;
  /** Maximum width in 3D units. Text wraps if wider. Default: Infinity (no wrap) */
  maxWidth?: number;
}

const DEFAULT_OPTIONS: Required<SpriteTextOptions> = {
  height: 0.1,
  fontSize: 48,
  color: '#ffffff',
  glow: 'transparent',
  weight: 300,
  font: 'Georgia, serif',
  additive: true,
  outline: 1,
  maxWidth: Infinity,
};

const DPR = Math.min(window.devicePixelRatio, 2);

export class SpriteText {
  /**
   * Create a text sprite. Returns a THREE.Sprite with correct aspect ratio.
   * The sprite's scale.y = options.height. scale.x = height * textAspect.
   */
  static create(text: string, options?: Partial<SpriteTextOptions>): THREE.Sprite {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const { canvas, aspect } = SpriteText.renderToCanvas(text, opts);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(opts.height * aspect, opts.height, 1);

    // Store metadata for later use
    sprite.userData.spriteText = {
      text,
      height: opts.height,
      aspect,
      canvas,
      texture,
    };

    return sprite;
  }

  /**
   * Create a multi-line text sprite. Lines are separated by \n.
   * Each line is rendered with proper line spacing.
   */
  static createMultiline(text: string, options?: Partial<SpriteTextOptions>): THREE.Sprite {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length <= 1) {
      return SpriteText.create(text.trim(), options);
    }

    const { canvas, aspect } = SpriteText.renderMultilineToCanvas(lines, opts);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const sprite = new THREE.Sprite(material);
    // For multiline, height covers all lines
    const totalHeight = opts.height * lines.length * 1.2;
    sprite.scale.set(totalHeight * aspect, totalHeight, 1);

    sprite.userData.spriteText = {
      text,
      height: totalHeight,
      aspect,
      canvas,
      texture,
    };

    return sprite;
  }

  /**
   * Update the text content of an existing sprite (re-renders canvas).
   * Preserves position and opacity. Returns the same sprite.
   */
  static updateText(sprite: THREE.Sprite, newText: string, options?: Partial<SpriteTextOptions>): void {
    const meta = sprite.userData.spriteText;
    if (!meta) return;

    const opts = { ...DEFAULT_OPTIONS, height: meta.height, ...options };
    const { canvas, aspect } = SpriteText.renderToCanvas(newText, opts);

    // Update existing texture
    const mat = sprite.material as THREE.SpriteMaterial;
    if (mat.map) {
      mat.map.dispose();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    mat.map = texture;
    mat.needsUpdate = true;

    // Update scale to match new aspect
    sprite.scale.set(opts.height * aspect, opts.height, 1);

    meta.text = newText;
    meta.aspect = aspect;
    meta.canvas = canvas;
    meta.texture = texture;
  }

  /** Set opacity with smooth fading */
  static setOpacity(sprite: THREE.Sprite, opacity: number): void {
    (sprite.material as THREE.SpriteMaterial).opacity = opacity;
  }

  /** Get the world-space width of a sprite text */
  static getWidth(sprite: THREE.Sprite): number {
    return sprite.scale.x;
  }

  /** Get the world-space height */
  static getHeight(sprite: THREE.Sprite): number {
    return sprite.scale.y;
  }

  /** Dispose a sprite text (cleanup texture + material) */
  static dispose(sprite: THREE.Sprite): void {
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  }

  // ══════════════════════════════════════════════════
  // Internal rendering
  // ══════════════════════════════════════════════════

  private static renderToCanvas(
    text: string,
    opts: Required<SpriteTextOptions>,
  ): { canvas: HTMLCanvasElement; aspect: number } {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const scaledFontSize = opts.fontSize * DPR;
    const font = `${opts.weight} ${scaledFontSize}px ${opts.font}`;
    ctx.font = font;

    // Measure text
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;
    const textHeight = scaledFontSize;

    // Canvas size: text + padding for glow
    const padX = scaledFontSize * 0.8;
    const padY = scaledFontSize * 0.6;
    canvas.width = Math.ceil(textWidth + padX * 2);
    canvas.height = Math.ceil(textHeight + padY * 2);

    // Render
    ctx.font = font; // reset after canvas resize
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // ── Glow halo — wide soft bloom behind text ──
    if (opts.glow !== 'transparent') {
      ctx.shadowColor = opts.glow;
      ctx.shadowBlur = 25 * DPR;
      ctx.fillStyle = opts.glow;
      ctx.globalAlpha = 0.3;
      ctx.fillText(text, cx, cy);
      ctx.globalAlpha = 1;
    }

    // ── Main text fill — bright and clean ──
    ctx.shadowColor = opts.glow !== 'transparent' ? opts.glow : 'transparent';
    ctx.shadowBlur = 10 * DPR;
    ctx.fillStyle = opts.color;
    ctx.fillText(text, cx, cy);

    // ── Second pass — boosts brightness for additive blending ──
    ctx.shadowBlur = 5 * DPR;
    ctx.globalAlpha = 0.6;
    ctx.fillText(text, cx, cy);
    ctx.globalAlpha = 1;

    ctx.shadowBlur = 0;

    return {
      canvas,
      aspect: canvas.width / canvas.height,
    };
  }

  private static renderMultilineToCanvas(
    lines: string[],
    opts: Required<SpriteTextOptions>,
  ): { canvas: HTMLCanvasElement; aspect: number } {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    const scaledFontSize = opts.fontSize * DPR;
    const font = `${opts.weight} ${scaledFontSize}px ${opts.font}`;
    const lineHeight = scaledFontSize * 1.4;
    ctx.font = font;

    // Measure widest line
    let maxWidth = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxWidth) maxWidth = w;
    }

    const padX = scaledFontSize * 0.8;
    const padY = scaledFontSize * 0.6;
    canvas.width = Math.ceil(maxWidth + padX * 2);
    canvas.height = Math.ceil(lineHeight * lines.length + padY * 2);

    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const cx = canvas.width / 2;

    for (let i = 0; i < lines.length; i++) {
      const cy = padY + lineHeight * (i + 0.5);

      // Glow halo
      if (opts.glow !== 'transparent') {
        ctx.shadowColor = opts.glow;
        ctx.shadowBlur = 25 * DPR;
        ctx.fillStyle = opts.glow;
        ctx.globalAlpha = 0.3;
        ctx.fillText(lines[i], cx, cy);
        ctx.globalAlpha = 1;
      }

      // Main fill
      ctx.shadowColor = opts.glow !== 'transparent' ? opts.glow : 'transparent';
      ctx.shadowBlur = 10 * DPR;
      ctx.fillStyle = opts.color;
      ctx.fillText(lines[i], cx, cy);

      // Brightness boost
      ctx.shadowBlur = 5 * DPR;
      ctx.globalAlpha = 0.6;
      ctx.fillText(lines[i], cx, cy);
      ctx.globalAlpha = 1;

      ctx.shadowBlur = 0;
    }

    return {
      canvas,
      aspect: canvas.width / canvas.height,
    };
  }
}

/**
 * Helper: create an orb glow sprite (radial gradient circle).
 * Returns a square sprite with perfectly circular glow.
 */
export function createOrbSprite(
  r: number, g: number, b: number,
  size = 0.15,
): THREE.Sprite {
  const res = Math.round(256 * DPR);
  const canvas = document.createElement('canvas');
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext('2d')!;

  const cx = res / 2;
  const orbR = res * 0.4;

  const ri = Math.round(r * 255);
  const gi = Math.round(g * 255);
  const bi = Math.round(b * 255);

  // Outer glow — soft, wide
  const outerGlow = ctx.createRadialGradient(cx, cx, 0, cx, cx, orbR);
  outerGlow.addColorStop(0, `rgba(${ri}, ${gi}, ${bi}, 0.6)`);
  outerGlow.addColorStop(0.3, `rgba(${ri}, ${gi}, ${bi}, 0.25)`);
  outerGlow.addColorStop(0.6, `rgba(${ri}, ${gi}, ${bi}, 0.08)`);
  outerGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = outerGlow;
  ctx.fillRect(0, 0, res, res);

  // Inner core — bright, concentrated
  const coreR = orbR * 0.35;
  const core = ctx.createRadialGradient(cx, cx, 0, cx, cx, coreR);
  core.addColorStop(0, `rgba(255, 255, 255, 0.9)`);
  core.addColorStop(0.2, `rgba(${Math.min(255, ri + 60)}, ${Math.min(255, gi + 60)}, ${Math.min(255, bi + 60)}, 0.7)`);
  core.addColorStop(0.6, `rgba(${ri}, ${gi}, ${bi}, 0.3)`);
  core.addColorStop(1, `rgba(${ri}, ${gi}, ${bi}, 0)`);
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, res, res);

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

  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size, size, 1); // square — always circular
  return sprite;
}
