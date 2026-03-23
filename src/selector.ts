import * as THREE from 'three';
import type { SessionConfig } from './session';
import { SpriteText, createOrbSprite } from './sprite-text';
import type { ExperienceLevel } from './experience-level';
import { LEVEL_LABELS } from './experience-level';

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
  private allSprites: THREE.Sprite[] = [];
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private disposed = false;

  // Tunnel control callbacks
  private _setThemeColors: ((colors: {
    c1: [number, number, number]; c2: [number, number, number];
    c3: [number, number, number]; c4: [number, number, number];
    particle: [number, number, number]; shape: number;
  }) => void) | null = null;
  private _setExperienceLevel: ((level: ExperienceLevel) => void) | null = null;

  constructor(
    sessions: SessionConfig[],
    onSelect: (session: SessionConfig) => void,
    scene: THREE.Scene,
    camera: THREE.Camera,
    canvas: HTMLCanvasElement,
  ) {
    this.sessions = sessions;
    this.onSelect = onSelect;
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.startSequence();
  }

  setThemeControl(setter: typeof this._setThemeColors): void {
    this._setThemeColors = setter;
  }

  setExperienceLevelControl(setter: (level: ExperienceLevel) => void): void {
    this._setExperienceLevel = setter;
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
      // No orbs yet — don't run carousel or description logic
      this.prevSelectedIndex = this.selectedIndex;
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

      // Target positions
      const targetX = diff * 0.6;
      const targetZ = -absDiff * 0.4;
      const targetY = -0.05 + Math.sin(time * 1.5 + i * 1.2) * 0.015;

      // Smooth lerp
      orb.position.x += (targetX - orb.position.x) * lerp;
      orb.position.z += (targetZ - orb.position.z) * lerp;
      orb.position.y += (targetY - orb.position.y) * lerp;

      // Orb scale: focused breathes bigger
      const orbTarget = focused ? 0.16 + breathPulse * 0.04 : Math.max(0.05, 0.11 - absDiff * 0.02);
      orb.scale.setScalar(orb.scale.x + (orbTarget - orb.scale.x) * lerp);

      // Orb opacity
      const orbMat = orb.material as THREE.SpriteMaterial;
      const orbAlpha = focused ? 0.9 : Math.max(0.15, 0.6 - absDiff * 0.2);
      orbMat.opacity += (orbAlpha - orbMat.opacity) * lerp;

      // Label follows orb, below it
      const labelMeta = label.userData.spriteText;
      const labelH = labelMeta?.height ?? 0.06;
      label.position.x += (targetX - label.position.x) * lerp;
      label.position.z += (targetZ - label.position.z) * lerp;
      label.position.y += (targetY - 0.12 - label.position.y) * lerp;

      // Label opacity
      const labelMat = label.material as THREE.SpriteMaterial;
      const labelAlpha = focused ? 0.9 : Math.max(0.1, 0.5 - absDiff * 0.2);
      labelMat.opacity += (labelAlpha - labelMat.opacity) * lerp;
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
      // Update description
      this.showDescription(session);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    if (this.clickHandler) this.canvas.removeEventListener('click', this.clickHandler);
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
    // ── Title + tagline + prompt — fast, together ──
    await this.sleep(500);
    if (this.disposed) return;

    const title = this.addSprite('H P Y N O', { height: 0.14, fontSize: 80, color: '#c8a0ff', glow: 'rgba(200,160,255,0.4)' }, 0, 0.12, -0.2);
    await this.animateIn(title, 1200);
    if (this.disposed) return;

    const tagline = this.addSprite('immersive hypnosis', { height: 0.05, fontSize: 32, color: '#9070bb', glow: 'rgba(144,112,187,0.3)' }, 0, -0.02, -0.1);
    this.animateIn(tagline, 800);

    await this.sleep(600);
    if (this.disposed) return;

    const isTouchDevice = 'ontouchstart' in window;
    const prompt = this.addSprite(
      isTouchDevice ? 'tap to enter' : 'press space',
      { height: 0.045, fontSize: 28, color: '#c8a0ff', glow: 'rgba(200,160,255,0.35)' },
      0, -0.14, -0.05,
    );
    await this.animateIn(prompt, 600);
    if (this.disposed) return;

    await this.waitForInput();
    if (this.disposed) return;

    // ── Transition ──
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

    // Create orbs + labels
    for (let i = 0; i < this.sessions.length; i++) {
      if (this.disposed) return;
      const s = this.sessions[i];
      const [r, g, b] = s.theme.accentColor;

      const orb = createOrbSprite(r, g, b, 0.12);
      orb.position.set(0, -0.05, 0);
      this.group.add(orb);
      this.orbSprites.push(orb);
      this.allSprites.push(orb);

      const label = SpriteText.create(s.name.toLowerCase(), {
        height: 0.06, fontSize: 36, color: s.theme.textColor, glow: s.theme.textGlow,
      });
      label.position.set(0, -0.17, 0);
      SpriteText.setOpacity(label, 0);
      this.group.add(label);
      this.orbLabels.push(label);
      this.allSprites.push(label);

      // Stagger in
      await this.sleep(100);
      if (this.disposed) return;
      this.fadeIn(orb, 0.6, 500);
      this.fadeIn(label, 0.6, 500);
    }

    this.selectedIndex = 0;
    this.prevSelectedIndex = -1; // force theme update on first frame

    const selected = await this.waitForChoice();
    if (this.disposed) return;
    const session = this.sessions[selected];

    // ── Selection: expand chosen, fade others ──
    question.visible = false;
    if (this.descSprite) this.animateOut(this.descSprite, 400);
    for (let i = 0; i < this.orbSprites.length; i++) {
      if (i !== selected) {
        this.animateOut(this.orbSprites[i], 500);
        this.animateOut(this.orbLabels[i], 500);
      }
    }
    this.animateOut(this.orbLabels[selected], 300);

    const chosen = this.orbSprites[selected];
    const expandStart = performance.now();
    await new Promise<void>(resolve => {
      const expand = () => {
        if (this.disposed) { resolve(); return; }
        const t = Math.min(1, (performance.now() - expandStart) / 1200);
        const ease = t * t * (3 - 2 * t);
        chosen.scale.setScalar(0.12 + ease * 2.0);
        (chosen.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - ease * 0.8);
        if (t < 1) requestAnimationFrame(expand);
        else resolve();
      };
      requestAnimationFrame(expand);
    });

    await this.sleep(200);

    // ── Content warning ──
    if (session.contentWarning) {
      chosen.visible = false;
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

    // Wait for selection — keyboard (1-4) or arrows + space
    let selectedLevel = 1; // default to 'watch'
    const chosen = await new Promise<number>(resolve => {
      const keyHandler = (e: KeyboardEvent) => {
        e.preventDefault();
        if (e.code === 'Digit1' || e.code === 'Numpad1') { cleanup(); resolve(0); }
        else if (e.code === 'Digit2' || e.code === 'Numpad2') { cleanup(); resolve(1); }
        else if (e.code === 'Digit3' || e.code === 'Numpad3') { cleanup(); resolve(2); }
        else if (e.code === 'Digit4' || e.code === 'Numpad4') { cleanup(); resolve(3); }
        else if (e.code === 'ArrowUp' || e.code === 'KeyW') {
          selectedLevel = Math.max(0, selectedLevel - 1);
          this.highlightLevel(levelSprites, levelDescSprites, selectedLevel);
        } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
          selectedLevel = Math.min(3, selectedLevel + 1);
          this.highlightLevel(levelSprites, levelDescSprites, selectedLevel);
        } else if (e.code === 'Space' || e.code === 'Enter') {
          cleanup(); resolve(selectedLevel);
        }
      };

      const clickHandler = () => { cleanup(); resolve(selectedLevel); };
      const touchHandler = (e: TouchEvent) => { e.preventDefault(); cleanup(); resolve(selectedLevel); };

      const cleanup = () => {
        window.removeEventListener('keydown', keyHandler);
        this.canvas.removeEventListener('click', clickHandler);
        this.canvas.removeEventListener('touchend', touchHandler);
      };

      window.addEventListener('keydown', keyHandler);
      this.canvas.addEventListener('click', clickHandler);
      this.canvas.addEventListener('touchend', touchHandler);

      // Highlight default
      this.highlightLevel(levelSprites, levelDescSprites, selectedLevel);
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
      this.animateOut(this.descSprite, 250);
      this.descSprite = null;
    }
    if (!session) return;

    // Short description
    let desc = session.description.split('.')[0];
    if (desc.length > 50) desc = desc.split(/\s+/).slice(0, 7).join(' ');

    const sprite = this.addSprite(desc, {
      height: 0.055, fontSize: 32, color: session.theme.textColor, glow: session.theme.textGlow,
    }, 0, -0.30, 0.05);
    this.descSprite = sprite;
    this.animateIn(sprite, 400);
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
      const cleanup = () => {
        window.removeEventListener('keydown', kh);
        this.canvas.removeEventListener('click', ch);
        this.canvas.removeEventListener('touchend', th);
      };
      const kh = (e: KeyboardEvent) => { if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); cleanup(); resolve(); } };
      const th = (e: TouchEvent) => { e.preventDefault(); cleanup(); resolve(); };
      const ch = () => { cleanup(); resolve(); };
      window.addEventListener('keydown', kh);
      this.canvas.addEventListener('click', ch);
      this.canvas.addEventListener('touchend', th);
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

      const keyHandler = (e: KeyboardEvent) => {
        e.preventDefault();
        if (e.code === 'ArrowLeft' || e.code === 'ArrowUp' || e.code === 'KeyA' || e.code === 'KeyW') {
          this.selectedIndex = (this.selectedIndex - 1 + this.sessions.length) % this.sessions.length;
        } else if (e.code === 'ArrowRight' || e.code === 'ArrowDown' || e.code === 'KeyD' || e.code === 'KeyS') {
          this.selectedIndex = (this.selectedIndex + 1) % this.sessions.length;
        } else if (e.code === 'Space' || e.code === 'Enter') {
          cleanup(); resolve(this.selectedIndex);
        }
      };

      const clickHandler = (e: MouseEvent) => {
        const idx = raycast(e.clientX, e.clientY);
        if (idx >= 0) { this.selectedIndex = idx; cleanup(); resolve(idx); }
      };

      const touchHandler = (e: TouchEvent) => {
        if (!e.changedTouches.length) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        const idx = raycast(t.clientX, t.clientY);
        if (idx >= 0) { this.selectedIndex = idx; cleanup(); resolve(idx); }
      };

      const cleanup = () => {
        window.removeEventListener('keydown', keyHandler);
        this.canvas.removeEventListener('click', clickHandler);
        this.canvas.removeEventListener('touchend', touchHandler);
      };

      this.keyHandler = keyHandler;
      this.clickHandler = clickHandler;
      window.addEventListener('keydown', keyHandler);
      this.canvas.addEventListener('click', clickHandler);
      this.canvas.addEventListener('touchend', touchHandler);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
