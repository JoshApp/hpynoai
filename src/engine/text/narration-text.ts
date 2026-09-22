/**
 * NarrationText — in-world narration on the overlay scene.
 *
 * Two styles:
 *   focus  — one word at a time, large, gentle punch on change (karaoke)
 *   prompt — a short line held steady (gate prompts, cues)
 * Built on SpriteText so text is always crisp and never squashed.
 */

import * as THREE from 'three';
import { SpriteText } from './sprite-text';

export interface NarrationTextOptions {
  color?: string;
  glow?: string;
  font?: string;
  z?: number;
  y?: number;
}

const DEFAULTS: Required<NarrationTextOptions> = {
  color: '#e9e4f0',
  glow: 'rgba(7, 4, 10, 0.9)',
  font: "'Cormorant Garamond', 'Iowan Old Style', Georgia, serif",
  z: -0.75,
  y: -0.3,
};

export class NarrationText {
  readonly group = new THREE.Group();
  private opts: Required<NarrationTextOptions>;
  private sprite: THREE.Sprite | null = null;
  private current = '';
  private style: 'focus' | 'prompt' | 'line' = 'focus';
  private lineActive = -1;
  private opacity = 0;
  private target = 0;
  private punch = 0;
  private baseHeight = 0.24;
  private textScale = 1;

  constructor(scene: THREE.Scene, opts: NarrationTextOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    scene.add(this.group);
  }

  /** User preference: 0.7..1.6 */
  setScale(s: number): void { this.textScale = s; }

  /** Show a single word (karaoke). Same word = no-op. */
  word(text: string): void { this.set(text, 'focus'); }

  /** Show a short held line (gate prompt). */
  prompt(text: string): void { this.set(text, 'prompt'); }

  private lineProgress = 0;

  /** Karaoke: whole line visible, words before `active` lit, the active word filling with `progress` 0..1. */
  karaoke(words: string[], active: number, progress = 0): void {
    const key = words.join(' ');
    if (!key) { this.clear(); return; }
    const q = WORD_FILL ? Math.round(Math.max(0, Math.min(1, progress)) * 8) / 8 : 1;
    if (key === this.current && this.style === 'line') {
      if (active !== this.lineActive || q !== this.lineProgress) { this.lineActive = active; this.lineProgress = q; this.rebuildKaraoke(words, active, q); }
      this.target = 1; return;
    }
    this.current = key; this.style = 'line'; this.lineActive = active; this.lineProgress = q;
    this.rebuildKaraoke(words, active, q);
    this.target = 1; this.punch = 0.3;
  }

  private rebuildKaraoke(words: string[], active: number, progress: number): void {
    const keepOpacity = this.sprite ? (this.sprite.material as THREE.SpriteMaterial).opacity : 0;
    this.disposeSprite();
    const { canvas, aspect } = renderKaraoke(words, active, progress, this.opts.font, this.opts.color);
    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter; texture.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: keepOpacity, depthTest: false, blending: THREE.NormalBlending });
    const sprite = new THREE.Sprite(mat);
    const height = this.baseHeight * this.textScale * 0.9 * (canvas.height / (KARAOKE_LINE_PX * KARAOKE_DPR));
    sprite.scale.set(height * aspect, height, 1);
    sprite.position.set(0, this.opts.y, this.opts.z);
    sprite.renderOrder = 500;
    this.sprite = sprite;
    this.group.add(sprite);
  }

  clear(): void { this.target = 0; }

  private set(text: string, style: 'focus' | 'prompt'): void {
    this.lineActive = -1;
    const t = text.trim();
    if (!t) { this.clear(); return; }
    if (t === this.current && style === this.style) { this.target = 1; return; }
    this.current = t;
    this.style = style;
    this.rebuild();
    this.target = 1;
    this.punch = style === 'focus' ? 1 : 0.3;
  }

  private rebuild(): void {
    this.disposeSprite();
    const isPrompt = this.style === 'prompt';
    const height = this.baseHeight * this.textScale * (isPrompt ? 0.75 : 1);
    this.sprite = SpriteText.create(this.current, {
      height,
      fontSize: 56,
      color: this.opts.color,
      glow: this.opts.glow,
      weight: isPrompt ? 500 : 600,
      font: this.opts.font,
      additive: false,
      outline: 0,
      maxWidth: isPrompt ? 1.6 : Infinity,
    });
    this.sprite.position.set(0, this.opts.y, this.opts.z);
    this.sprite.renderOrder = 500;
    (this.sprite.material as THREE.SpriteMaterial).opacity = this.opacity;
    this.group.add(this.sprite);
  }

  update(dt: number, breathValue: number): void {
    if (!this.sprite) return;
    const rate = this.target > this.opacity ? 10 : 3;
    this.opacity += (this.target - this.opacity) * (1 - Math.exp(-rate * dt));
    this.punch *= Math.exp(-4 * dt);
    const mat = this.sprite.material as THREE.SpriteMaterial;
    mat.opacity = Math.min(0.96, this.opacity * (0.92 + breathValue * 0.08));
    const s = 1 + this.punch * 0.04;
    const base = this.sprite.userData['baseScale'] as THREE.Vector3 | undefined;
    if (!base) this.sprite.userData['baseScale'] = this.sprite.scale.clone();
    const b = (this.sprite.userData['baseScale'] as THREE.Vector3);
    this.sprite.scale.set(b.x * s, b.y * s, 1);
    this.sprite.position.y = this.opts.y + (breathValue - 0.5) * 0.012;
    if (this.opacity < 0.01 && this.target === 0) { this.disposeSprite(); this.current = ''; }
  }

  private disposeSprite(): void {
    if (this.sprite) delete this.sprite.userData['baseScale'];
    if (!this.sprite) return;
    this.group.remove(this.sprite);
    const mat = this.sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.sprite = null;
  }

  dispose(): void { this.disposeSprite(); this.group.parent?.remove(this.group); }
}

/** In-word left→right fill. Off: the whole active word lights at once (calmer to read). */
const WORD_FILL = false;
const KARAOKE_LINE_PX = 64;
const KARAOKE_DPR = 2;
const LIT = '#ff9aa8';
const DIM = 'rgba(233,228,240,0.66)';

/** Draw a wrapped line: spoken words in `color`, the active word filling left→right with `progress`, the rest dimmed. */
function renderKaraoke(words: string[], active: number, progress: number, font: string, color: string): { canvas: HTMLCanvasElement; aspect: number } {
  const fontPx = 40 * KARAOKE_DPR;
  const maxW = 760 * KARAOKE_DPR;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const setFont = (): void => { ctx.font = `600 ${fontPx}px ${font}`; };
  setFont();
  const space = ctx.measureText(' ').width;
  const rows: { start: number; end: number; width: number }[] = [];
  let rs = 0, w = 0;
  for (let i = 0; i < words.length; i++) {
    const ww = ctx.measureText(words[i]!).width;
    if (w > 0 && w + space + ww > maxW) { rows.push({ start: rs, end: i, width: w }); rs = i; w = ww; }
    else w += (w > 0 ? space : 0) + ww;
  }
  rows.push({ start: rs, end: words.length, width: w });
  const lineH = KARAOKE_LINE_PX * KARAOKE_DPR;
  const pad = 24 * KARAOKE_DPR;
  canvas.width = Math.ceil(Math.max(...rows.map(r => r.width)) + pad * 2);
  canvas.height = Math.ceil(rows.length * lineH + pad * 2);
  setFont();
  ctx.textBaseline = 'middle';
  // Pass 1: soft dark shadow plate (no stroke — strokes are what looked dirty)
  ctx.save();
  ctx.shadowColor = 'rgba(7,4,10,1)'; ctx.shadowBlur = 30 * KARAOKE_DPR; ctx.shadowOffsetY = 2 * KARAOKE_DPR;
  ctx.fillStyle = 'rgba(7,4,10,0.8)';
  rows.forEach((r, ri) => {
    let x = (canvas.width - r.width) / 2; const y = pad + lineH * (ri + 0.5);
    for (let i = r.start; i < r.end; i++) { for (let k = 0; k < 3; k++) ctx.fillText(words[i]!, x, y); x += ctx.measureText(words[i]!).width + space; }
  });
  ctx.restore();
  // Pass 2: glyphs
  rows.forEach((r, ri) => {
    let x = (canvas.width - r.width) / 2; const y = pad + lineH * (ri + 0.5);
    for (let i = r.start; i < r.end; i++) {
      const word = words[i]!; const ww = ctx.measureText(word).width;
      if (i < active) { ctx.fillStyle = color; ctx.fillText(word, x, y); }
      else if (i > active) { ctx.fillStyle = DIM; ctx.fillText(word, x, y); }
      else {
        ctx.fillStyle = DIM; ctx.fillText(word, x, y);
        const cut = x + ww * progress;
        ctx.save(); ctx.beginPath(); ctx.rect(x - 2, y - lineH / 2, Math.max(0, cut - x + 2), lineH); ctx.clip();
        ctx.fillStyle = LIT; ctx.fillText(word, x, y); ctx.restore();
      }
      x += ww + space;
    }
  });
  return { canvas, aspect: canvas.width / canvas.height };
}
