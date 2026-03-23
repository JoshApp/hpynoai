import * as THREE from 'three';

/**
 * 3D text — two modes:
 *
 * show():        Floating karaoke — lines spawn far in the tunnel and drift
 *                toward you with word-by-word reveal. For narration/suggestions.
 *
 * showInstant():  Static two-line display — text appears immediately close to
 *                 camera with full opacity. For gates/prompts.
 */

export interface Text3DSettings {
  startZ: number;
  endZ: number;
  scale: number;
}

// ── Floating line (karaoke narration) ──
interface WordTiming {
  word: string;
  start: number;  // seconds from line start
  end: number;
}

interface FloatingLine {
  mesh: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  words: string[];
  wordTimings: WordTiming[] | null;
  startTime: number;
  duration: number;
  startZ: number;
  endZ: number;
  baseY: number;
  baseScale: number;
  audioRef: HTMLAudioElement | null;  // if set, sync karaoke to audio.currentTime
  audioLineStart: number;             // offset in audio where this line starts
  aspect: number;
  revealPerWord: number;
}

// ── Static slot (instant prompts) ──
interface TextSlot {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  opacity: number;
  targetOpacity: number;
  expireTime: number;
}

const FONT_SIZE = 48;
const FONT = `300 ${FONT_SIZE}px Georgia, serif`;
const SLOT_FADE_SPEED = 2.5;
const SLOT_LINE_SPACING = 0.12;

export class Text3D {
  private group: THREE.Group;
  private textColor = '#c8a0ff';
  private glowColor = 'rgba(200, 160, 255, 0.4)';
  private breathPhase = 0;
  private _settings: Text3DSettings = { startZ: -1.8, endZ: -0.55, scale: 1.4 };

  // Floating lines (narration)
  private lines: FloatingLine[] = [];

  // Static slots (prompts) — upper (0) and lower (1)
  private slots: [TextSlot | null, TextSlot | null] = [null, null];

  // Cue — single persistent text that updates in place (breathing in/hold/out)
  private cueSprite: THREE.Sprite | null = null;
  private cueText = '';
  private cueOpacity = 0;
  private cueTargetOpacity = 0;
  private cueZ = -1.0;
  private cueY = -0.2;

  constructor() {
    this.group = new THREE.Group();
  }

  setSettings(s: Text3DSettings): void {
    this._settings = s;
  }

  get mesh(): THREE.Group {
    return this.group;
  }

  setColors(textColor: string, glowColor: string): void {
    this.textColor = textColor;
    this.glowColor = glowColor;
  }

  // ════════════════════════════════════════════════════════
  // Floating karaoke (narration)
  // ════════════════════════════════════════════════════════

  show(text: string, duration = 8, wordTimings?: Array<{ word: string; start: number; end: number }>, audioRef?: HTMLAudioElement | null, audioLineStart?: number): void {
    this.fadeOutExistingLines();

    const rawLines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Split into display lines — keep short text as 1 line, split long text at ~5 words
    let displayLines: string[];
    if (rawLines.length === 1) {
      const words = rawLines[0].split(/\s+/);
      if (words.length <= 5) {
        // Short enough for one line
        displayLines = [rawLines[0]];
      } else {
        // Split into lines of ~4-5 words
        displayLines = [];
        const wordsPerLine = Math.max(4, Math.ceil(words.length / 2));
        for (let i = 0; i < words.length; i += wordsPerLine) {
          displayLines.push(words.slice(i, i + wordsPerLine).join(' '));
        }
      }
    } else {
      displayLines = rawLines;
    }

    const totalWords = displayLines.reduce((sum, l) => sum + l.split(/\s+/).length, 0);
    const revealTime = wordTimings ? (wordTimings[wordTimings.length - 1]?.end ?? duration * 0.4) : duration * 0.4;
    const revealPerWord = revealTime / Math.max(totalWords, 1);

    // Line spacing scales with text size so lines never overlap
    const baseScale = 0.25 * this._settings.scale;
    const lineSpacing = baseScale * 1.3;  // 130% of text height
    const totalHeight = (displayLines.length - 1) * lineSpacing;
    let wordOffset = 0;

    for (let li = 0; li < displayLines.length; li++) {
      const lineText = displayLines[li];
      const words = lineText.split(/\s+/);
      const { canvas, ctx, texture, aspect } = this.createTexture(words.join(' '));

      // Extract word timings for this display line
      let lineWordTimings: WordTiming[] | null = null;
      if (wordTimings) {
        lineWordTimings = wordTimings.slice(wordOffset, wordOffset + words.length);
      }

      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      });

      const sprite = new THREE.Sprite(material);
      sprite.scale.set(baseScale * aspect, baseScale, 1);

      const startZ = this._settings.startZ;
      const y = (totalHeight / 2) - li * lineSpacing;
      sprite.position.set(0, y, startZ);

      this.group.add(sprite);
      this.lines.push({
        mesh: sprite,
        canvas,
        ctx,
        texture,
        words,
        wordTimings: lineWordTimings,
        startTime: performance.now() / 1000,
        duration,
        startZ,
        endZ: this._settings.endZ,
        baseY: y,
        baseScale,
        aspect,
        revealPerWord,
        audioRef: audioRef ?? null,
        audioLineStart: audioLineStart ?? 0,
      });

      wordOffset += words.length;
    }
  }

  private fadeOutExistingLines(): void {
    const now = performance.now() / 1000;
    for (const line of this.lines) {
      const elapsed = now - line.startTime;
      if (elapsed < 0) {
        line.duration = 0.2;
        line.startTime = now;
      } else {
        const remaining = line.duration - elapsed;
        // Quick 0.6s fade — old text should be gone before new text is fully visible
        if (remaining > 0.6) {
          line.duration = elapsed + 0.6;
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // Instant static text (prompts/gates)
  // ════════════════════════════════════════════════════════

  showInstant(text: string, duration = 15): void {
    this.clear();

    const rawLines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let displayLines: string[];
    if (rawLines.length === 1) {
      const words = rawLines[0].split(/\s+/);
      if (words.length > 4) {
        const mid = Math.ceil(words.length / 2);
        displayLines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
      } else {
        displayLines = [rawLines[0]];
      }
    } else {
      displayLines = rawLines.slice(0, 2);
    }

    const now = performance.now() / 1000;

    if (displayLines.length === 2) {
      this.slots[0] = this.createSlot(displayLines[0], now + duration);
      this.slots[1] = this.createSlot(displayLines[1], now + duration);
    } else {
      this.slots[0] = null;
      this.slots[1] = this.createSlot(displayLines[0], now + duration);
    }

    this.repositionSlots();
  }

  private createSlot(text: string, expireTime: number): TextSlot {
    const { canvas, ctx, texture, aspect } = this.createTexture(text);
    this.renderTextFull(ctx, canvas, text);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    const sprite = new THREE.Sprite(material);
    const scale = 0.3 * this._settings.scale;
    sprite.scale.set(scale * aspect, scale, 1);
    sprite.position.z = this._settings.endZ - 0.3;

    this.group.add(sprite);

    return { sprite, canvas, texture, opacity: 0.85, targetOpacity: 0.85, expireTime };
  }

  private repositionSlots(): void {
    const breathVal = Math.sin(this.breathPhase) * 0.5 + 0.5; // 0-1
    const baseZ = this._slotDepthOverride ?? (this._settings.endZ - 0.3);
    // When slot depth is overridden (breathing guide), move with breath in Z
    const breathZ = this._slotDepthOverride !== null ? breathVal * 0.4 : 0;
    const z = baseZ + breathZ;

    const hasTwo = this.slots[0] !== null && this.slots[1] !== null;
    const offset = hasTwo ? SLOT_LINE_SPACING / 2 : 0;
    const breathY = (breathVal - 0.5) * 0.025;
    const baseY = -0.2;

    if (this.slots[0]) this.slots[0].sprite.position.set(0, baseY + offset + breathY, z);
    if (this.slots[1]) this.slots[1].sprite.position.set(0, baseY + (hasTwo ? -offset : 0) + breathY, z);
  }

  // ════════════════════════════════════════════════════════
  // Cue text (breathing in/hold/out, stage indicators)
  // ════════════════════════════════════════════════════════

  /** Show or update the cue text. Stays in place, dip-fades on change. */
  showCue(text: string): void {
    if (text === this.cueText && this.cueSprite) return; // no change

    const isFirst = !this.cueSprite;
    this.cueText = text;

    // Create or re-render the sprite
    if (this.cueSprite) {
      this.group.remove(this.cueSprite);
      const mat = this.cueSprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }

    const { canvas, ctx, texture, aspect } = this.createTexture(text);
    this.renderTextFull(ctx, canvas, text);
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.cueSprite = new THREE.Sprite(material);
    const scale = 0.25 * this._settings.scale;
    this.cueSprite.scale.set(scale * aspect, scale, 1);
    this.cueSprite.position.set(0, this.cueY, this.cueZ);
    this.group.add(this.cueSprite);

    if (isFirst) {
      // First appearance: fade in from 0
      this.cueOpacity = 0;
      this.cueTargetOpacity = 0.85;
    } else {
      // Update: dip then recover
      this.cueOpacity = 0.15;
      this.cueTargetOpacity = 0.85;
    }
  }

  /** Set cue position (Y and Z) */
  setCuePosition(y: number, z: number): void {
    this.cueY = y;
    this.cueZ = z;
    if (this.cueSprite) {
      this.cueSprite.position.y = y;
      this.cueSprite.position.z = z;
    }
  }

  /** Hide the cue with a fade */
  hideCue(): void {
    this.cueTargetOpacity = 0;
  }

  /** Remove the cue immediately */
  clearCue(): void {
    if (this.cueSprite) {
      this.group.remove(this.cueSprite);
      const mat = this.cueSprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.cueSprite = null;
    }
    this.cueText = '';
    this.cueOpacity = 0;
    this.cueTargetOpacity = 0;
  }

  /** Override slot Z depth — used by breathing guide to match wisp depth */
  setSlotDepth(z: number): void {
    this._slotDepthOverride = z;
  }

  clearSlotDepth(): void {
    this._slotDepthOverride = null;
  }

  /** Brief opacity dip on slots — visual cue that text is changing */
  dipSlotOpacity(): void {
    for (let i = 0; i < 2; i++) {
      const slot = this.slots[i as 0 | 1];
      if (slot) {
        slot.opacity = 0.15; // dip low, will recover via the normal fade-in
        slot.targetOpacity = 0.85;
      }
    }
  }

  private _slotDepthOverride: number | null = null;

  private removeSlot(index: 0 | 1): void {
    const slot = this.slots[index];
    if (!slot) return;
    this.group.remove(slot.sprite);
    slot.texture.dispose();
    (slot.sprite.material as THREE.SpriteMaterial).dispose();
    this.slots[index] = null;
  }

  // ════════════════════════════════════════════════════════
  // Shared helpers
  // ════════════════════════════════════════════════════════

  private createTexture(text: string): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    texture: THREE.CanvasTexture;
    aspect: number;
  } {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    ctx.font = FONT;

    const metrics = ctx.measureText(text);
    const pad = FONT_SIZE * 0.6;
    canvas.width = Math.ceil(metrics.width + pad * 2);
    canvas.height = Math.ceil(FONT_SIZE * 2 + pad * 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    return { canvas, ctx, texture, aspect: canvas.width / canvas.height };
  }

  /** Render full text at once (for instant/prompts) */
  private renderTextFull(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, text: string): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, cx, cy);

    ctx.shadowColor = this.glowColor;
    ctx.shadowBlur = 20;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = this.textColor;
    ctx.fillText(text, cx, cy);
    ctx.globalAlpha = 0.3;
    ctx.fillText(text, cx, cy);

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  /** Redraw a floating line with karaoke word reveal */
  private redrawLineKaraoke(line: FloatingLine, revealProgress: number): void {
    const { canvas, ctx, words } = line;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const cy = canvas.height / 2;
    const padding = FONT_SIZE * 0.6;
    const spaceWidth = ctx.measureText(' ').width;
    let x = padding;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordWidth = ctx.measureText(word).width;

      // Wider reveal window (1.5 words) for smoother blending between words
      const rawReveal = (revealProgress - i) / 1.5;
      const wordReveal = Math.max(0, Math.min(1, rawReveal));

      if (wordReveal > 0) {
        // Smooth cubic ease for a softer, more gradual appearance
        const alpha = wordReveal * wordReveal * (3 - 2 * wordReveal); // smoothstep

        // Dark outline — fades in with word
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.globalAlpha = alpha * 0.4;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeText(word, x, cy);

        // Glow builds gradually — starts wide and soft, tightens as word solidifies
        ctx.shadowColor = this.glowColor;
        ctx.shadowBlur = 25 - alpha * 10; // wider blur when fading in, tighter when solid
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillStyle = this.textColor;
        ctx.fillText(word, x, cy);

        // Extra soft glow pass
        ctx.globalAlpha = (1 - alpha) * 0.4; // stronger glow when word is still appearing
        ctx.shadowBlur = 30;
        ctx.fillText(word, x, cy);
      }

      x += wordWidth + spaceWidth;
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    line.texture.needsUpdate = true;
  }

  /** Karaoke reveal synced to Whisper word timestamps */
  private redrawLineTimestamped(line: FloatingLine, elapsed: number): void {
    const { canvas, ctx, words, wordTimings } = line;
    if (!wordTimings) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const cy = canvas.height / 2;
    const padding = FONT_SIZE * 0.6;
    const spaceWidth = ctx.measureText(' ').width;
    let x = padding;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordWidth = ctx.measureText(word).width;
      const timing = wordTimings[i];

      let alpha = 0;
      if (timing) {
        // Word reveal based on actual speech timing
        if (elapsed >= timing.end) {
          alpha = 1; // fully revealed
        } else if (elapsed >= timing.start) {
          // Fading in during the word's duration
          const wordDur = Math.max(timing.end - timing.start, 0.1);
          alpha = (elapsed - timing.start) / wordDur;
        }
        // Smoothstep for softer appearance
        alpha = alpha * alpha * (3 - 2 * alpha);
      }

      if (alpha > 0) {
        // Dark outline
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.globalAlpha = alpha * 0.4;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeText(word, x, cy);

        // Glow + fill
        ctx.shadowColor = this.glowColor;
        ctx.shadowBlur = 25 - alpha * 10;
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillStyle = this.textColor;
        ctx.fillText(word, x, cy);

        // Soft glow while appearing
        ctx.globalAlpha = (1 - alpha) * 0.4;
        ctx.shadowBlur = 30;
        ctx.fillText(word, x, cy);
      }

      x += wordWidth + spaceWidth;
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    line.texture.needsUpdate = true;
  }

  // ════════════════════════════════════════════════════════
  // Update (called every frame)
  // ════════════════════════════════════════════════════════

  update(_intensity: number, breathPhase?: number): void {
    if (breathPhase !== undefined) this.breathPhase = breathPhase;
    const now = performance.now() / 1000;
    const breathPulse = Math.sin(this.breathPhase) * 0.5 + 0.5;

    // ── Update floating lines (narration) — reverse iterate to allow in-place removal ──
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i];

      // For audio-synced lines, elapsed comes from the audio element's clock
      let elapsed: number;
      if (line.audioRef && line.wordTimings) {
        elapsed = line.audioRef.currentTime - line.audioLineStart;
      } else {
        elapsed = now - line.startTime;
      }

      if (elapsed < 0) {
        (line.mesh.material as THREE.SpriteMaterial).opacity = 0;
        continue;
      }

      const progress = elapsed / line.duration;

      if (progress > 1) {
        this.group.remove(line.mesh);
        line.texture.dispose();
        (line.mesh.material as THREE.SpriteMaterial).dispose();
        this.lines.splice(i, 1);
        continue;
      }

      // Z: gentle drift from far to near — reduced range so text doesn't travel too far
      const zRange = Math.min(line.endZ - line.startZ, 0.5); // cap travel to 0.5 units
      const z = line.startZ + zRange * this.easeOut(progress);
      line.mesh.position.z = z;

      // Y: gentle lift on inhale, sink on exhale (from stored base position)
      line.mesh.position.y = line.baseY + (breathPulse - 0.5) * 0.03;

      // Scale grows gently as it approaches — capped to prevent edge clipping
      const scaleBoost = 1.0 + progress * 0.15;
      const scale = line.baseScale * scaleBoost;
      line.mesh.scale.set(scale * line.aspect, scale, 1);

      // Karaoke word reveal — use Whisper timestamps if available
      if (line.wordTimings && line.wordTimings.length > 0) {
        this.redrawLineTimestamped(line, elapsed);
      } else {
        const revealProgress = elapsed / line.revealPerWord;
        this.redrawLineKaraoke(line, revealProgress);
      }

      // Opacity envelope — fade in quick, hold, fade out at end
      let opacity: number;
      if (progress < 0.08) {
        // Fade in: quick, first 8%
        const t = progress / 0.08;
        opacity = t * t * (3 - 2 * t);
      } else if (progress > 0.75) {
        // Fade out: last 25%
        const t = (progress - 0.75) / 0.25;
        opacity = 1 - t * t;
      } else {
        opacity = 1;
      }

      opacity *= 0.6 + breathPulse * 0.3;
      opacity = Math.min(opacity, 0.85);

      (line.mesh.material as THREE.SpriteMaterial).opacity = opacity;
    }

    // ── Update static slots (prompts) ──
    const dt = 1 / 60;
    for (let i = 0; i < 2; i++) {
      const slot = this.slots[i as 0 | 1];
      if (!slot) continue;

      if (now >= slot.expireTime && slot.targetOpacity > 0) {
        slot.targetOpacity = 0;
      }

      if (slot.opacity < slot.targetOpacity) {
        slot.opacity = Math.min(slot.targetOpacity, slot.opacity + SLOT_FADE_SPEED * dt);
      } else if (slot.opacity > slot.targetOpacity) {
        slot.opacity = Math.max(slot.targetOpacity, slot.opacity - SLOT_FADE_SPEED * dt);
      }

      if (slot.opacity <= 0.01 && slot.targetOpacity === 0) {
        this.removeSlot(i as 0 | 1);
        continue;
      }

      const breathMod = 0.7 + breathPulse * 0.3;
      (slot.sprite.material as THREE.SpriteMaterial).opacity = slot.opacity * breathMod;

    }

    // Reposition slots every frame (breath-driven Z movement)
    this.repositionSlots();

    // ── Update cue ──
    if (this.cueSprite) {
      // Smooth fade
      this.cueOpacity += (this.cueTargetOpacity - this.cueOpacity) * 0.12;

      if (this.cueOpacity < 0.01 && this.cueTargetOpacity === 0) {
        this.clearCue();
      } else {
        const breathMod = 0.7 + breathPulse * 0.3;
        (this.cueSprite.material as THREE.SpriteMaterial).opacity = this.cueOpacity * breathMod;

        // Update Z from slot depth override (breath-driven movement)
        if (this._slotDepthOverride !== null) {
          this.cueSprite.position.z = this._slotDepthOverride;
          this.cueSprite.position.y = this.cueY;
        }
      }
    }
  }

  /** Fade out all text over ~0.5s, then remove. */
  fadeOut(): void {
    // Floating lines — shorten their remaining duration
    const now = performance.now() / 1000;
    for (const line of this.lines) {
      const elapsed = now - line.startTime;
      if (elapsed < 0) {
        line.duration = 0;
      } else {
        const remaining = line.duration - elapsed;
        if (remaining > 0.5) {
          line.duration = elapsed + 0.5;
        }
      }
    }

    // Static slots — fade to 0
    for (let i = 0; i < 2; i++) {
      const slot = this.slots[i as 0 | 1];
      if (slot) {
        slot.targetOpacity = 0;
        slot.expireTime = 0;
      }
    }
  }

  /** Immediately remove all text (no fade). */
  clear(): void {
    for (const line of this.lines) {
      this.group.remove(line.mesh);
      line.texture.dispose();
      (line.mesh.material as THREE.SpriteMaterial).dispose();
    }
    this.lines = [];

    this.removeSlot(0);
    this.removeSlot(1);
  }

  private easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  private easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
  }
}
