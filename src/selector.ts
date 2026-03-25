import * as THREE from 'three';
import type { SessionConfig } from './session';
import { SpriteText, createOrbSprite } from './sprite-text';
import type { ExperienceLevel } from './experience-level';
import { LEVEL_LABELS } from './experience-level';
import type { EventBus } from './events';

/**
 * Immersive 3D session selector — the landing IS the experience.
 *
 * Uses SpriteText for all text rendering (DPR-aware, never squashed).
 * Carousel layout with theme preview on the tunnel.
 */
export class SessionSelector {
  private group: THREE.Group;
  private onSelect: (session: SessionConfig) => void;
  private sessions: SessionConfig[];
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private canvas: HTMLCanvasElement;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private selectedIndex = 0;
  private prevSelectedIndex = -1;
  private orbSprites: THREE.Sprite[] = [];
  private orbLabels: THREE.Sprite[] = [];
  private descSprite: THREE.Sprite | null = null;
  private promptSprite: THREE.Sprite | null = null;
  private allSprites: THREE.Sprite[] = [];
  private disposed = false;
  private bus: EventBus;
  private unsubs: Array<() => void> = [];

  // Tunnel control callbacks
  private _setThemeColors: ((colors: {
    c1: [number, number, number]; c2: [number, number, number];
    c3: [number, number, number]; c4: [number, number, number];
    particle: [number, number, number]; shape: number;
  }) => void) | null = null;
  private _setExperienceLevel: ((level: ExperienceLevel) => void) | null = null;
  private _setPresenceTarget: ((x: number, y: number, z: number) => void) | null = null;
  private _pulsePresence: (() => void) | null = null;
  private _onSessionPreview: ((session: import('./session').SessionConfig) => void) | null = null;

  constructor(
    sessions: SessionConfig[],
    onSelect: (session: SessionConfig) => void,
    scene: THREE.Scene,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
    bus: EventBus,
    skipIntro = false,
  ) {
    this.sessions = sessions;
    this.onSelect = onSelect;
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.bus = bus;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    if (skipIntro) {
      this.showCarousel();
    } else {
      this.startSequence();
    }
  }

  setThemeControl(setter: typeof this._setThemeColors): void {
    this._setThemeColors = setter;
  }

  setAudioPreview(fn: (session: import('./session').SessionConfig) => void): void {
    this._onSessionPreview = fn;
  }

  setExperienceLevelControl(setter: (level: ExperienceLevel) => void): void {
    this._setExperienceLevel = setter;
  }

  setPresenceControl(setter: (x: number, y: number, z: number) => void, pulse?: () => void): void {
    this._setPresenceTarget = setter;
    this._pulsePresence = pulse ?? null;
  }

  setDepth(z: number): void {
    this.group.position.z = z;
  }

  setScale(s: number): void {
    this.group.scale.set(s, s, 1);
  }

  // ── Per-frame update: carousel layout + theme preview ──
  update(time: number): void {
    if (this.disposed) return;
    const n = this.orbSprites.length;
    if (n === 0) {
      // No orbs yet — don't run carousel or description logic, but pulse the CTA
      this.prevSelectedIndex = this.selectedIndex;
      if (this.promptSprite) {
        const pulse = 0.4 + Math.sin(time * 2.0) * 0.25;
        (this.promptSprite.material as THREE.SpriteMaterial).opacity = pulse;
      }
      return;
    }

    const breathPulse = Math.sin(time * 0.8) * 0.5 + 0.5;
    const lerp = 0.06;

    for (let i = 0; i < n; i++) {
      const orb = this.orbSprites[i];
      const label = this.orbLabels[i];
      if (!orb.visible) continue;

      // Carousel: distance from focused (wrapping)
      let diff = i - this.selectedIndex;
      if (diff > n / 2) diff -= n;
      if (diff < -n / 2) diff += n;
      const focused = diff === 0;
      const absDiff = Math.abs(diff);

      // ── Carousel physics: spring-based easing for organic motion ──
      const targetX = diff * 0.55;
      const targetZ = -absDiff * 0.35 - (focused ? 0.05 : 0); // focused comes slightly forward
      const targetY = -0.03 + Math.sin(time * 1.2 + i * 1.5) * 0.012;

      // Spring lerp — faster for focused, slower for distant (depth-of-field feel)
      const springRate = focused ? 0.12 : 0.06 + absDiff * 0.01;
      orb.position.x += (targetX - orb.position.x) * springRate;
      orb.position.z += (targetZ - orb.position.z) * springRate;
      orb.position.y += (targetY - orb.position.y) * springRate;

      // Orb scale: focused breathes + pulses, distant shrinks
      const focusedScale = 0.28 + breathPulse * 0.05 + Math.sin(time * 2) * 0.01;
      const distantScale = Math.max(0.06, 0.16 - absDiff * 0.04);
      const orbTarget = focused ? focusedScale : distantScale;
      orb.scale.setScalar(orb.scale.x + (orbTarget - orb.scale.x) * springRate);

      // Orb opacity — focused fades for wisp, near ones visible, far ones ghost
      const orbMat = orb.material as THREE.SpriteMaterial;
      const orbAlpha = focused ? 0.1 : absDiff <= 1 ? 0.55 : Math.max(0.08, 0.35 - absDiff * 0.12);
      orbMat.opacity += (orbAlpha - orbMat.opacity) * springRate;

      // Label follows orb
      label.position.x += (targetX - label.position.x) * springRate;
      label.position.z += (targetZ - label.position.z) * springRate;
      label.position.y += (targetY - 0.13 - label.position.y) * springRate;

      // Label opacity — focused bright, near visible, far ghosted
      const labelMat = label.material as THREE.SpriteMaterial;
      const labelAlpha = focused ? 0.95 : absDiff <= 1 ? 0.5 : Math.max(0.06, 0.3 - absDiff * 0.12);
      labelMat.opacity += (labelAlpha - labelMat.opacity) * springRate;
    }

    // Move presence to focused orb position
    if (this.orbSprites.length > 0 && this._setPresenceTarget) {
      const focusedOrb = this.orbSprites[this.selectedIndex];
      if (focusedOrb) {
        this._setPresenceTarget(
          focusedOrb.position.x,
          focusedOrb.position.y + 0.02,
          focusedOrb.position.z - 0.1,
        );
      }
    }

    // Theme preview on selection change
    if (this.selectedIndex !== this.prevSelectedIndex) {
      this.prevSelectedIndex = this.selectedIndex;
      const session = this.sessions[this.selectedIndex];
      if (session && this._setThemeColors) {
        this._setThemeColors({
          c1: session.theme.primaryColor,
          c2: session.theme.secondaryColor,
          c3: session.theme.accentColor,
          c4: session.theme.bgColor,
          particle: session.theme.particleColor,
          shape: session.theme.tunnelShape ?? 0,
        });
      }
      // Audio preview
      if (this._onSessionPreview) this._onSessionPreview(session);
      // Update description
      this.showDescription(session);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    for (const sprite of this.allSprites) {
      this.group.remove(sprite);
      SpriteText.dispose(sprite);
    }
    this.scene.remove(this.group);
    this.allSprites = [];
    this.orbSprites = [];
    this.orbLabels = [];
  }

  // ══════════════════════════════════════════
  // Cinematic entry sequence
  // ══════════════════════════════════════════

  private async startSequence(): Promise<void> {
    // ── Title screen — text arranged around the wisp ──
    // The wisp is the centerpiece at y≈0, z≈-1.5
    // Title sits above it, tagline + prompt below
    await this.sleep(400);
    if (this.disposed) return;

    // Title — large, commanding, above the wisp
    const title = this.addSprite('H P Y N O', {
      height: 0.18, fontSize: 96, color: '#d4b8ff', glow: 'rgba(200,160,255,0.5)',
    }, 0, 0.30, -0.15);
    await this.animateIn(title, 1400);
    if (this.disposed) return;

    // Tagline — tight below the wisp
    const tagline = this.addSprite('immersive hypnosis', {
      height: 0.06, fontSize: 38, color: '#b89ee0', glow: 'rgba(184,158,224,0.4)',
    }, 0, -0.15, -0.06);
    this.animateIn(tagline, 1000);

    await this.sleep(600);
    if (this.disposed) return;

    // CTA — large, prominent, pulsing
    const isTouchDevice = 'ontouchstart' in window;
    const prompt = this.addSprite(
      isTouchDevice ? 'tap to enter' : 'press space',
      { height: 0.06, fontSize: 38, color: '#e0c8ff', glow: 'rgba(224,200,255,0.5)' },
      0, -0.26, -0.02,
    );
    this.promptSprite = prompt;
    await this.animateIn(prompt, 800);
    if (this.disposed) return;

    await this.waitForInput();
    if (this.disposed) return;

    // ── Transition — stop prompt pulse, fade everything out ──
    this.promptSprite = null;
    this.animateOut(title, 600);
    this.animateOut(tagline, 500);
    this.animateOut(prompt, 400);

    await this.sleep(700);
    if (this.disposed) return;

    // ── Experience level picker (first visit only) ──
    const hasChosenLevel = localStorage.getItem('hpyno-level-set') === 'true';
    if (!hasChosenLevel && this._setExperienceLevel) {
      await this.showLevelPicker();
      if (this.disposed) return;
      await this.sleep(500);
      if (this.disposed) return;
    }

    // ── "what do you seek" + carousel ──
    const question = this.addSprite('what do you seek', { height: 0.10, fontSize: 56, color: '#a080cc', glow: 'rgba(160,128,204,0.3)' }, 0, 0.28, -0.1);
    await this.animateIn(question, 800);
    if (this.disposed) return;

    // Create orbs + labels — pre-positioned at their carousel positions
    const n = this.sessions.length;
    for (let i = 0; i < n; i++) {
      if (this.disposed) return;
      const s = this.sessions[i];
      const [r, g, b] = s.theme.accentColor;

      // Pre-calculate carousel position so they appear in the right place
      let diff = i - 0; // relative to selectedIndex 0
      if (diff > n / 2) diff -= n;
      if (diff < -n / 2) diff += n;
      const absDiff = Math.abs(diff);
      const posX = diff * 0.6;
      const posZ = -absDiff * 0.4;
      const posY = -0.05;

      const orb = createOrbSprite(r, g, b, 0.22);
      orb.position.set(posX, posY, posZ);
      (orb.material as THREE.SpriteMaterial).opacity = 0;
      this.group.add(orb);
      this.orbSprites.push(orb);
      this.allSprites.push(orb);

      const label = SpriteText.create(s.name.toLowerCase(), {
        height: 0.06, fontSize: 36, color: s.theme.textColor, glow: s.theme.textGlow,
      });
      label.position.set(posX, posY - 0.12, posZ);
      SpriteText.setOpacity(label, 0);
      this.group.add(label);
      this.orbLabels.push(label);
      this.allSprites.push(label);
    }

    // Fade in all at once — no stagger, they're already positioned
    for (let i = 0; i < n; i++) {
      if (i === 0) {
        // First orb invisible (wisp absorbs it)
        this.fadeIn(this.orbLabels[i], 0.6, 800);
      } else {
        this.fadeIn(this.orbSprites[i], 0.5, 800);
        this.fadeIn(this.orbLabels[i], 0.5, 800);
      }
    }

    this.selectedIndex = 0;
    this.prevSelectedIndex = -1; // force theme update on first frame

    const selected = await this.waitForChoice();
    if (this.disposed) return;
    const session = this.sessions[selected];

    // ── Selection animation: chosen expands, others fade ──
    this.animateOut(question, 400);
    if (this.descSprite) this.animateOut(this.descSprite, 300);
    if ((this as unknown as Record<string, THREE.Sprite | null>)._infoSprite) {
      this.animateOut((this as unknown as Record<string, THREE.Sprite>)._infoSprite, 300);
    }

    // Fade non-selected orbs, brighten selected label
    for (let i = 0; i < this.orbSprites.length; i++) {
      if (i === selected) {
        // Selected: label brightens, orb glows
        const selLabel = this.orbLabels[i];
        if (selLabel) (selLabel.material as THREE.SpriteMaterial).opacity = 1;
      } else {
        this.animateOut(this.orbSprites[i], 600);
        this.animateOut(this.orbLabels[i], 600);
      }
    }

    // Pulse the wisp
    if (this._pulsePresence) this._pulsePresence();

    await this.sleep(800);

    // Now fade the selected label too
    if (this.orbLabels[selected]) this.animateOut(this.orbLabels[selected], 500);
    if (this.orbSprites[selected]) this.animateOut(this.orbSprites[selected], 500);

    await this.sleep(600);

    // ── Content warning ──
    if (session.contentWarning) {
      const warning = this.addSprite(session.contentWarning, {
        height: 0.06, fontSize: 36, color: '#cc8090', glow: 'rgba(200,80,100,0.3)',
      }, 0, 0.1, -0.1);
      await this.animateIn(warning, 500);

      const confirmText = isTouchDevice ? 'tap to enter' : 'press space to enter';
      const confirm = this.addSprite(confirmText, {
        height: 0.04, fontSize: 28, color: '#8060aa', glow: 'rgba(128,96,170,0.3)',
      }, 0, -0.1, -0.1);
      await this.animateIn(confirm, 400);

      await this.waitForInput();
      for (const s of this.allSprites) this.animateOut(s, 600);
      await this.sleep(600);
    }

    this.onSelect(session);
    this.dispose();
  }

  /** Skip intro — go straight to carousel (used when returning from session) */
  private async showCarousel(): Promise<void> {
    await this.sleep(300);
    if (this.disposed) return;

    const question = this.addSprite('what do you seek', { height: 0.10, fontSize: 56, color: '#a080cc', glow: 'rgba(160,128,204,0.3)' }, 0, 0.28, -0.1);
    await this.animateIn(question, 800);
    if (this.disposed) return;

    // Create orbs + labels
    const n = this.sessions.length;
    for (let i = 0; i < n; i++) {
      if (this.disposed) return;
      const s = this.sessions[i];
      const [r, g, b] = s.theme.accentColor;
      let diff = i - 0;
      if (diff > n / 2) diff -= n;
      if (diff < -n / 2) diff += n;
      const absDiff = Math.abs(diff);
      const posX = diff * 0.6;
      const posZ = -absDiff * 0.4;
      const posY = -0.05;

      const orb = createOrbSprite(r, g, b, 0.22);
      orb.position.set(posX, posY, posZ);
      (orb.material as THREE.SpriteMaterial).opacity = 0;
      this.group.add(orb);
      this.orbSprites.push(orb);
      this.allSprites.push(orb);

      const label = SpriteText.create(s.name.toLowerCase(), {
        height: 0.06, fontSize: 36, color: s.theme.textColor, glow: s.theme.textGlow,
      });
      label.position.set(posX, posY - 0.12, posZ);
      SpriteText.setOpacity(label, 0);
      this.group.add(label);
      this.orbLabels.push(label);
      this.allSprites.push(label);
    }

    for (let i = 0; i < n; i++) {
      if (i === 0) {
        this.fadeIn(this.orbLabels[i], 0.6, 800);
      } else {
        this.fadeIn(this.orbSprites[i], 0.5, 800);
        this.fadeIn(this.orbLabels[i], 0.5, 800);
      }
    }

    this.selectedIndex = 0;
    this.prevSelectedIndex = -1;

    const selected = await this.waitForChoice();
    if (this.disposed) return;
    const session = this.sessions[selected];

    question.visible = false;
    if (this.descSprite) this.animateOut(this.descSprite, 400);
    for (let i = 0; i < this.orbSprites.length; i++) {
      this.animateOut(this.orbSprites[i], 500);
      this.animateOut(this.orbLabels[i], 500);
    }
    if (this._pulsePresence) this._pulsePresence();
    await this.sleep(1200);

    if (session.contentWarning) {
      const warning = this.addSprite(session.contentWarning, {
        height: 0.06, fontSize: 36, color: '#cc8090', glow: 'rgba(200,80,100,0.3)',
      }, 0, 0.1, -0.1);
      await this.animateIn(warning, 500);
      const ctext = 'ontouchstart' in window ? 'tap to enter' : 'press space to enter';
      const confirm = this.addSprite(ctext, {
        height: 0.04, fontSize: 28, color: '#8060aa', glow: 'rgba(128,96,170,0.3)',
      }, 0, -0.1, -0.1);
      await this.animateIn(confirm, 400);
      await this.waitForInput();
      for (const s of this.allSprites) this.animateOut(s, 600);
      await this.sleep(600);
    }

    this.onSelect(session);
    this.dispose();
  }

  // ══════════════════════════════════════════
  // ── In-tunnel experience level picker ──

  private async showLevelPicker(): Promise<void> {
    const title = this.addSprite('how would you like to experience this?', {
      height: 0.065, fontSize: 36, color: '#c8a0ff', glow: 'rgba(200,160,255,0.3)',
    }, 0, 0.28, -0.1);
    await this.animateIn(title, 800);
    if (this.disposed) return;

    // Create level option sprites
    const levels: ExperienceLevel[] = ['listen', 'watch', 'breathe', 'immerse'];
    const levelSprites: THREE.Sprite[] = [];
    const levelDescSprites: THREE.Sprite[] = [];

    for (let i = 0; i < levels.length; i++) {
      const lvl = levels[i];
      const info = LEVEL_LABELS[lvl];
      const y = 0.12 - i * 0.09;

      const nameSprite = this.addSprite(`${info.icon}  ${info.name}`, {
        height: 0.055, fontSize: 36, color: '#c8a0ff', glow: 'rgba(200,160,255,0.3)',
      }, -0.15, y, -0.05);
      levelSprites.push(nameSprite);

      const descSprite = this.addSprite(info.desc, {
        height: 0.03, fontSize: 22, color: '#887aaa', glow: 'rgba(136,122,170,0.2)',
      }, 0.2, y, -0.05);
      levelDescSprites.push(descSprite);

      await this.sleep(80);
      if (this.disposed) return;
      this.animateIn(nameSprite, 500);
      this.animateIn(descSprite, 500);
    }

    // Wait for selection via bus events
    let selectedLevel = 1; // default to 'watch'
    this.highlightLevel(levelSprites, levelDescSprites, selectedLevel);

    const chosen = await new Promise<number>(resolve => {
      const cleanup = () => { for (const u of subs) u(); };
      const subs: Array<() => void> = [];

      // Up/left = previous level, down/right = next level
      subs.push(this.bus.on('input:left', () => {
        selectedLevel = Math.max(0, selectedLevel - 1);
        this.highlightLevel(levelSprites, levelDescSprites, selectedLevel);
      }));
      subs.push(this.bus.on('input:right', () => {
        selectedLevel = Math.min(3, selectedLevel + 1);
        this.highlightLevel(levelSprites, levelDescSprites, selectedLevel);
      }));
      subs.push(this.bus.on('input:confirm', () => {
        cleanup();
        resolve(selectedLevel);
      }));

      this.unsubs.push(...subs);
    });

    if (this.disposed) return;

    // Apply selection
    const level = levels[chosen];
    if (this._setExperienceLevel) {
      this._setExperienceLevel(level);
    }
    localStorage.setItem('hpyno-level-set', 'true');

    // Fade out
    this.animateOut(title, 500);
    for (const s of levelSprites) this.animateOut(s, 400);
    for (const s of levelDescSprites) this.animateOut(s, 400);
    await this.sleep(500);
  }

  private highlightLevel(names: THREE.Sprite[], descs: THREE.Sprite[], selected: number): void {
    for (let i = 0; i < names.length; i++) {
      const active = i === selected;
      const included = i < selected;
      const nameMat = names[i].material as THREE.SpriteMaterial;
      const descMat = descs[i].material as THREE.SpriteMaterial;
      // Active = bright, included = medium, above = dim
      nameMat.opacity = active ? 0.95 : included ? 0.6 : 0.3;
      descMat.opacity = active ? 0.7 : included ? 0.4 : 0.2;
    }
  }

  // Helpers
  // ══════════════════════════════════════════

  private addSprite(text: string, opts: { height: number; fontSize: number; color: string; glow: string }, x: number, y: number, z: number): THREE.Sprite {
    const sprite = SpriteText.create(text, opts);
    sprite.position.set(x, y, z);
    // Store target scale for animateIn, zero it
    sprite.userData._targetScale = sprite.scale.clone();
    sprite.scale.set(0, 0, 1);
    SpriteText.setOpacity(sprite, 0);
    this.group.add(sprite);
    this.allSprites.push(sprite);
    return sprite;
  }

  private showDescription(session: SessionConfig): void {
    if (this.descSprite) {
      this.animateOut(this.descSprite, 200);
      this.descSprite = null;
    }
    // Remove extra info sprite if it exists
    if ((this as unknown as Record<string, THREE.Sprite | null>)._infoSprite) {
      this.animateOut((this as unknown as Record<string, THREE.Sprite>)._infoSprite, 200);
      (this as unknown as Record<string, THREE.Sprite | null>)._infoSprite = null;
    }
    if (!session) return;

    // Short description — first sentence, trimmed
    let desc = session.description.split('.')[0];
    if (desc.length > 55) desc = desc.split(/\s+/).slice(0, 8).join(' ') + '…';

    const sprite = this.addSprite(desc, {
      height: 0.048, fontSize: 30, color: session.theme.textColor, glow: session.theme.textGlow,
    }, 0, -0.28, 0.05);
    this.descSprite = sprite;
    this.animateIn(sprite, 350);

    // Duration + stage count info line
    const totalDur = session.stages.reduce((sum, s) => sum + s.duration, 0);
    const mins = Math.ceil(totalDur / 60);
    const stageCount = session.stages.length;
    const infoText = `${mins} min  ·  ${stageCount} stages`;

    const info = this.addSprite(infoText, {
      height: 0.028, fontSize: 20, color: '#8070a0', glow: 'rgba(128,112,160,0.15)',
    }, 0, -0.34, 0.05);
    (this as unknown as Record<string, THREE.Sprite>)._infoSprite = info;
    this.animateIn(info, 400);
  }

  // ── Animations ──

  private animateIn(sprite: THREE.Sprite, durationMs: number): Promise<void> {
    const mat = sprite.material as THREE.SpriteMaterial;
    const target = sprite.userData._targetScale as THREE.Vector3 | undefined;
    const tx = target?.x ?? (sprite.scale.x || 0.1);
    const ty = target?.y ?? (sprite.scale.y || 0.1);
    const start = performance.now();

    return new Promise(resolve => {
      const tick = () => {
        if (this.disposed) { resolve(); return; }
        const t = Math.min(1, (performance.now() - start) / durationMs);
        const ease = 1 - (1 - t) * (1 - t);
        mat.opacity = ease * 0.9;
        sprite.scale.set(tx * ease, ty * ease, 1);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private fadeIn(sprite: THREE.Sprite, targetOpacity: number, durationMs: number): void {
    const mat = sprite.material as THREE.SpriteMaterial;
    const start = performance.now();
    const tick = () => {
      if (this.disposed) return;
      const t = Math.min(1, (performance.now() - start) / durationMs);
      mat.opacity = t * targetOpacity;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private animateOut(sprite: THREE.Sprite, durationMs: number): void {
    const mat = sprite.material as THREE.SpriteMaterial;
    const startOpacity = mat.opacity;
    const start = performance.now();
    const tick = () => {
      if (this.disposed) return;
      const t = Math.min(1, (performance.now() - start) / durationMs);
      mat.opacity = startOpacity * (1 - t);
      if (t >= 1) sprite.visible = false;
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ── Input ──

  private waitForInput(): Promise<void> {
    return new Promise(resolve => {
      const unsub = this.bus.on('input:confirm', () => {
        unsub();
        resolve();
      });
      this.unsubs.push(unsub);
    });
  }

  private waitForChoice(): Promise<number> {
    return new Promise(resolve => {
      const raycast = (cx: number, cy: number): number => {
        this.pointer.set((cx / this.canvas.clientWidth) * 2 - 1, -(cy / this.canvas.clientHeight) * 2 + 1);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this.orbSprites);
        return hits.length > 0 ? this.orbSprites.indexOf(hits[0].object as THREE.Sprite) : -1;
      };

      let resolved = false;
      const subs: Array<() => void> = [];
      const done = (idx: number) => {
        if (resolved) return;
        resolved = true;
        for (const u of subs) u();
        resolve(idx);
      };

      subs.push(this.bus.on('input:left', () => {
        this.selectedIndex = (this.selectedIndex - 1 + this.sessions.length) % this.sessions.length;
      }));

      subs.push(this.bus.on('input:right', () => {
        this.selectedIndex = (this.selectedIndex + 1) % this.sessions.length;
      }));

      // Tap/click: raycast on orbs, or confirm current selection
      subs.push(this.bus.on('input:tap', ({ clientX, clientY }) => {
        const idx = raycast(clientX, clientY);
        done(idx >= 0 ? idx : this.selectedIndex);
      }));

      // Keyboard Space/Enter (doesn't emit input:tap, only input:confirm)
      subs.push(this.bus.on('input:confirm', () => {
        done(this.selectedIndex);
      }));

      this.unsubs.push(...subs);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
