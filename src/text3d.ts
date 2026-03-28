import * as THREE from 'three';

/**
 * Unified 3D text display — one active display at a time.
 *
 * API:
 *   set(text, style, opts?)  — show text with the given style, replaces previous
 *   set(null)                — clear everything
 *   update(intensity, phase) — call each frame for animations
 *
 * Styles:
 *   'cue'       — centered, dip-fade on change, depth-driven (breathing labels)
 *   'prompt'    — centered two-line, persistent (gate prompts)
 *   'narration' — centered two-line (TTS text fallback)
 *   'focus'     — word-by-word with audio sync (pre-recorded narration)
 */

export type TextStyle = 'cue' | 'narration' | 'prompt' | 'focus';

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface TextOptions {
  words?: WordTiming[];
  audioRef?: HTMLAudioElement | null;
  audioLineStart?: number;
  depth?: number;          // Z override (breathing blocks)
}

export interface Text3DSettings {
  startZ: number;
  endZ: number;
  scale: number;
}

const FONT_SIZE = 48;
const FONT = `300 ${FONT_SIZE}px Georgia, serif`;

export class Text3D {
  private group: THREE.Group;
  private textColor = '#c8a0ff';
  private glowColor = 'rgba(200, 160, 255, 0.4)';
  private breathPhase = 0;
  private _settings: Text3DSettings = { startZ: -1.8, endZ: -0.55, scale: 1.4 };

  // ── Current display state ──
  private activeStyle: TextStyle | null = null;
  private activeText: string | null = null;
  private depth: number | null = null;

  // Sprites — up to 2 lines for prompt/narration, 1 for cue/focus
  private sprites: THREE.Sprite[] = [];
  private spriteAspects: number[] = [];

  // Opacity animation
  private opacity = 0;
  private targetOpacity = 0;

  // Focus mode state
  private focusWords: WordTiming[] = [];
  private focusAudioRef: HTMLAudioElement | null = null;
  private focusLineStart = 0;
  private focusCurrentWord = '';
  private focusScalePunch = 0;

  constructor() {
    this.group = new THREE.Group();
  }

  get mesh(): THREE.Group { return this.group; }

  setSettings(s: Text3DSettings): void { this._settings = s; }

  setColors(textColor: string, glowColor: string): void {
    this.textColor = textColor;
    this.glowColor = glowColor;
  }

  // ════════════════════════════════════════════════════════
  // SET — the only public entry point for showing text
  // ════════════════════════════════════════════════════════

  set(text: string | null, style?: TextStyle, opts?: TextOptions): void {
    // Clear
    if (text === null || text === undefined) {
      this.clearSprites();
      this.activeText = null;
      this.activeStyle = null;
      this.depth = null;
      this.focusWords = [];
      this.focusAudioRef = null;
      this.focusCurrentWord = '';
      this.targetOpacity = 0;
      return;
    }

    const resolvedStyle = style ?? 'narration';

    // Update depth
    this.depth = opts?.depth ?? null;

    // Focus mode — special handling (word-by-word, sprite redrawn per word)
    if (resolvedStyle === 'focus') {
      this.setFocus(text, opts);
      return;
    }

    // If same text + style, nothing to do (prevents flicker)
    if (text === this.activeText && resolvedStyle === this.activeStyle) return;

    // Different text or style — rebuild sprites
    this.clearSprites();
    this.activeText = text;
    this.activeStyle = resolvedStyle;
    this.focusWords = [];
    this.focusAudioRef = null;

    // Split text into display lines
    const lines = this.splitLines(text);
    const scale = this.scaleForStyle(resolvedStyle);
    const z = this.zForStyle(resolvedStyle);

    for (let i = 0; i < lines.length; i++) {
      const { texture, aspect } = this.createTexture(lines[i]);
      this.renderTextFull(lines[i], texture);

      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthTest: false,
        blending: THREE.NormalBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(scale * aspect, scale, 1);
      sprite.position.z = z;

      this.group.add(sprite);
      this.sprites.push(sprite);
      this.spriteAspects.push(aspect);
    }

    // Position lines vertically
    this.positionLines();

    // Opacity: dip on change for cue, instant for prompt/narration
    if (resolvedStyle === 'cue') {
      this.targetOpacity = 0.85;
      this.opacity = 0.15; // dip-fade
    } else {
      this.targetOpacity = 0.85;
      this.opacity = 0.85; // instant
    }
  }

  /** Alias for backwards compat */
  clear(): void { this.set(null); }

  /** Force reset — clears cached state so next set() rebuilds even with same text */
  reset(): void {
    this.clearSprites();
    this.activeText = null;
    this.activeStyle = null;
    this.focusCurrentWord = '';
    this.focusWords = [];
  }

  // Legacy compat methods used by interactions.ts / calibration — forward to set()
  show(text: string, _duration?: number, _words?: unknown, _audioRef?: unknown, _audioLineStart?: unknown): void { this.set(text, 'narration'); }
  showFocus(text: string, _duration: number, words?: Array<{ word: string; start: number; end: number }>, audioRef?: HTMLAudioElement | null, audioLineStart?: number): void { this.set(text, 'focus', { words, audioRef, audioLineStart }); }
  showCue(text: string): void { this.set(text, 'cue'); }
  showInstant(text: string, _duration = 30): void { this.set(text, 'prompt'); }
  hideCue(): void { this.set(null); }
  clearCue(): void { this.set(null); }
  setSlotDepth(z: number): void { this.depth = z; }
  clearSlotDepth(): void { this.depth = null; }

  /** Fade out current display */
  fadeOut(): void { this.targetOpacity = 0; }

  // ════════════════════════════════════════════════════════
  // Focus mode — word-by-word display synced to audio
  // ════════════════════════════════════════════════════════

  private setFocus(text: string, opts?: TextOptions): void {
    const words = opts?.words;
    const audioRef = opts?.audioRef ?? null;
    const lineStart = opts?.audioLineStart ?? 0;

    // Check if this is the same focus line (avoid re-init on every frame)
    if (this.activeStyle === 'focus' && this.activeText === text) {
      // Just update audio ref in case it changed
      this.focusAudioRef = audioRef;
      this.focusLineStart = lineStart;
      return;
    }

    // New focus line
    this.activeStyle = 'focus';
    this.activeText = text;
    this.focusCurrentWord = '';
    this.focusScalePunch = 0;
    this.focusAudioRef = audioRef;
    this.focusLineStart = lineStart;

    // Build word timing
    const textWords = text.split(/\s+/).filter(w => w.length > 0);
    if (words && words.length > 0) {
      this.focusWords = words;
    } else {
      // Even spread fallback
      const dur = 5;
      const wordDur = dur / textWords.length;
      this.focusWords = textWords.map((w, i) => ({
        word: w,
        start: i * wordDur,
        end: (i + 1) * wordDur,
      }));
    }

    // Create single sprite for focus (redrawn per word when first word arrives)
    this.clearSprites();
    const { texture, aspect } = this.createTexture(' ');
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    const sprite = new THREE.Sprite(material);
    const scale = 0.3 * this._settings.scale;
    sprite.scale.set(scale * aspect, scale, 1);
    sprite.position.set(0, -0.25, this._settings.endZ - 0.15);
    this.group.add(sprite);
    this.sprites.push(sprite);
    this.spriteAspects.push(aspect);

    this.opacity = 0;
    this.targetOpacity = 0; // stays invisible until first word arrives
  }

  // ════════════════════════════════════════════════════════
  // UPDATE — call every frame
  // ════════════════════════════════════════════════════════

  update(intensity: number, breathPhaseRaw: number): void {
    this.breathPhase = breathPhaseRaw;
    const breathPulse = Math.sin(breathPhaseRaw) * 0.5 + 0.5;

    if (this.sprites.length === 0) {
      this.opacity = 0;
      return;
    }

    // Focus mode: word progression
    if (this.activeStyle === 'focus' && this.focusWords.length > 0) {
      this.updateFocus(breathPulse);
      return;
    }

    // Smooth opacity
    const fadeSpeed = this.activeStyle === 'cue' ? 0.12 : 0.2;
    this.opacity += (this.targetOpacity - this.opacity) * fadeSpeed;

    // Remove sprites when fully faded
    if (this.opacity < 0.01 && this.targetOpacity === 0) {
      this.clearSprites();
      this.activeText = null;
      this.activeStyle = null;
      return;
    }

    // Breath modulation — strong for cue (breathing labels pulse), subtle for text
    const breathMod = this.activeStyle === 'cue'
      ? 0.6 + breathPulse * 0.4   // cue: 60-100% (visible pulse)
      : 0.9 + breathPulse * 0.1;  // narration/prompt: 90-100% (barely noticeable)
    const finalOpacity = Math.min(0.95, this.opacity * breathMod);
    for (const sprite of this.sprites) {
      (sprite.material as THREE.SpriteMaterial).opacity = finalOpacity;
    }

    // Z: use depth override or default for style
    const z = this.depth ?? this.zForStyle(this.activeStyle ?? 'narration');
    for (const sprite of this.sprites) {
      sprite.position.z = z;
    }

    // Breath-driven Y movement
    const breathY = (breathPulse - 0.5) * 0.025;
    this.positionLines(breathY);
  }

  private updateFocus(breathPulse: number): void {
    if (this.sprites.length === 0) return;
    const sprite = this.sprites[0];

    // Get elapsed time from audio or wall clock
    let elapsed: number;
    if (this.focusAudioRef) {
      elapsed = this.focusAudioRef.currentTime - this.focusLineStart;
    } else {
      elapsed = 0;
    }

    // Find current word
    let activeWord = '';
    for (let i = 0; i < this.focusWords.length; i++) {
      const w = this.focusWords[i];
      const nextStart = i + 1 < this.focusWords.length
        ? this.focusWords[i + 1].start
        : w.end + 0.5;
      if (elapsed >= w.start && elapsed < nextStart) {
        activeWord = w.word;
        break;
      }
    }

    // Past last word — fade out
    const lastWord = this.focusWords[this.focusWords.length - 1];
    if (lastWord && elapsed >= lastWord.end + 0.5) {
      this.targetOpacity = 0;
    }

    // Word changed — redraw sprite, trigger gentle scale punch
    if (activeWord && activeWord !== this.focusCurrentWord) {
      this.focusCurrentWord = activeWord;
      this.renderFocusWord(sprite, activeWord);
      this.targetOpacity = 1;
      this.focusScalePunch = 0.6; // subtler punch than before
    }

    // Decay punch (slower settle for elegance)
    this.focusScalePunch *= 0.92;
    if (this.focusScalePunch < 0.005) this.focusScalePunch = 0;

    // Smooth opacity — faster fade in, slower fade out
    const opacitySpeed = this.targetOpacity > this.opacity ? 0.2 : 0.08;
    this.opacity += (this.targetOpacity - this.opacity) * opacitySpeed;

    // Minimal breath modulation for focus text (words should be steady and readable)
    const breathMod = 0.92 + breathPulse * 0.08;
    (sprite.material as THREE.SpriteMaterial).opacity =
      Math.max(0, Math.min(0.95, this.opacity * breathMod));

    // Scale with subtle punch
    const baseScale = 0.38 * this._settings.scale; // bigger for readability
    const punch = 1 + this.focusScalePunch * 0.05; // 5% max, not 8%
    const aspect = this.spriteAspects[0] ?? 1;
    sprite.scale.set(baseScale * aspect * punch, baseScale * punch, 1);

    // Position — centered, gentle breath sway
    sprite.position.y = -0.15 + (breathPulse - 0.5) * 0.015;

    // Cleanup when fully faded
    if (this.opacity < 0.01 && this.targetOpacity === 0) {
      this.clearSprites();
      this.activeText = null;
      this.activeStyle = null;
    }
  }

  private renderFocusWord(sprite: THREE.Sprite, word: string): void {
    const { texture, aspect } = this.createTexture(word);
    this.renderTextFull(word, texture);

    const mat = sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.map = texture;
    mat.needsUpdate = true;
    this.spriteAspects[0] = aspect;
  }

  // ════════════════════════════════════════════════════════
  // Rendering helpers
  // ════════════════════════════════════════════════════════

  private createTexture(text: string): { texture: THREE.CanvasTexture; aspect: number } {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = FONT;

    const metrics = ctx.measureText(text);
    const pad = FONT_SIZE * 1.2; // larger padding so glow + backdrop don't clip
    canvas.width = Math.ceil(metrics.width + pad * 2);
    canvas.height = Math.ceil(FONT_SIZE * 2.5 + pad * 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    return { texture, aspect: canvas.width / canvas.height };
  }

  private renderTextFull(text: string, texture: THREE.CanvasTexture): void {
    const canvas = texture.image as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    // Soft dark halo behind text (shadow only, no fill on the text shape itself)
    ctx.globalAlpha = 0.0;
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 40;
    // Draw invisible text — only the shadow renders (creates halo without muddying center)
    ctx.fillText(text, cx, cy);
    ctx.fillText(text, cx, cy);

    // Crisp dark outline
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1.0;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, cx, cy);

    // Main text — fully opaque, clean color
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = this.textColor;
    ctx.shadowColor = this.glowColor;
    ctx.shadowBlur = 15;
    ctx.fillText(text, cx, cy);

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    texture.needsUpdate = true;
  }

  private splitLines(text: string): string[] {
    const rawLines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (rawLines.length === 1) {
      const words = rawLines[0].split(/\s+/);
      if (words.length > 4) {
        const mid = Math.ceil(words.length / 2);
        return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
      }
      return [rawLines[0]];
    }
    return rawLines.slice(0, 2);
  }

  private scaleForStyle(style: TextStyle): number {
    const base = 0.3 * this._settings.scale;
    switch (style) {
      case 'cue': return base * 1.5;    // breathing labels: large and prominent
      case 'prompt': return base * 1.2;  // gate prompts: slightly larger
      default: return base * 1.15;       // narration: bigger for readability
    }
  }

  private zForStyle(style: TextStyle): number {
    switch (style) {
      case 'cue': return -0.85;          // breathing labels: close, center stage
      case 'focus': return this._settings.endZ - 0.1;
      default: return this._settings.endZ - 0.2;
    }
  }

  private positionLines(breathY = 0): void {
    // Y position — consistent across styles (cue and narration at same height)
    const baseY = -0.15;
    const spacing = 0.12;
    const hasTwo = this.sprites.length === 2;
    const offset = hasTwo ? spacing / 2 : 0;

    if (this.sprites[0]) {
      this.sprites[0].position.y = baseY + (hasTwo ? offset : 0) + breathY;
    }
    if (this.sprites[1]) {
      this.sprites[1].position.y = baseY - offset + breathY;
    }
  }

  private clearSprites(): void {
    for (const sprite of this.sprites) {
      this.group.remove(sprite);
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    this.sprites = [];
    this.spriteAspects = [];
    this.opacity = 0;
    this.targetOpacity = 0;
  }
}
