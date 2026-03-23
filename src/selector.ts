import * as THREE from 'three';
import type { SessionConfig } from './session';

/**
 * 3D session selector — everything lives in the tunnel.
 * Title, question, and session orbs are all Three.js sprites.
 * Keyboard + click/tap to select via raycasting.
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
  private orbSprites: THREE.Sprite[] = [];
  private orbLabels: THREE.Sprite[] = [];
  private allSprites: THREE.Sprite[] = []; // for cleanup
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;
  private disposed = false;

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

  /** Move the entire menu plane to a new depth */
  setDepth(z: number): void {
    this.group.position.z = z - (-1.5);
  }

  /** Scale the entire menu */
  setScale(s: number): void {
    this.group.scale.setScalar(s);
  }

  /** Call from animateBackground to bob/pulse orbs */
  update(time: number): void {
    if (this.disposed) return;
    for (let i = 0; i < this.orbSprites.length; i++) {
      const orb = this.orbSprites[i];
      if (!orb.visible) continue;
      // Gentle bob
      const baseY = -0.05;
      orb.position.y = baseY + Math.sin(time * 1.5 + i * 1.2) * 0.02;
      // Focused orb pulses bigger
      const focused = i === this.selectedIndex;
      const baseScale = focused ? 0.18 : 0.12;
      const pulse = focused ? Math.sin(time * 3) * 0.015 : 0;
      orb.scale.setScalar(baseScale + pulse);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    if (this.clickHandler) this.canvas.removeEventListener('click', this.clickHandler);
    for (const sprite of this.allSprites) {
      this.group.remove(sprite);
      const mat = sprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    this.scene.remove(this.group);
    this.allSprites = [];
    this.orbSprites = [];
    this.orbLabels = [];
  }

  private async startSequence(): Promise<void> {
    // Phase 1: Brief void
    await this.sleep(800);
    if (this.disposed) return;

    // Phase 2: Title floats in
    const title = this.makeTextSprite('H P Y N O', 80, '#c8a0ff', 'rgba(200,160,255,0.4)');
    title.position.set(0, 0.3, -2);
    title.scale.set(0, 0, 1);
    this.group.add(title);
    this.allSprites.push(title);
    await this.animateIn(title, 0.8, 1000);
    if (this.disposed) return;

    // Phase 3: "press space" prompt appears alongside title
    const prompt = this.makeTextSprite('press space', 36, '#8060aa', 'rgba(128,96,170,0.3)');
    prompt.position.set(0, 0.05, -1.8);
    prompt.scale.set(0, 0, 1);
    this.group.add(prompt);
    this.allSprites.push(prompt);
    await this.animateIn(prompt, 0.35, 800);
    if (this.disposed) return;

    await this.waitForSpace();
    if (this.disposed) return;

    // Space pressed — title recedes, prompt fades
    this.animateOut(prompt, 500);
    this.animateOut(title, 600);

    await this.sleep(600);
    if (this.disposed) return;

    // Phase 4: Question + orbs appear together
    const question = this.makeTextSprite('what do you seek', 48, '#a080cc', 'rgba(160,128,204,0.3)');
    question.position.set(0, 0.35, -1.8);
    question.scale.set(0, 0, 1);
    this.group.add(question);
    this.allSprites.push(question);
    await this.animateIn(question, 0.6, 800);
    if (this.disposed) return;

    // Phase 5: Orbs appear
    const orbSpacing = 0.55;
    const totalWidth = (this.sessions.length - 1) * orbSpacing;
    const startX = -totalWidth / 2;

    for (let i = 0; i < this.sessions.length; i++) {
      if (this.disposed) return;
      const s = this.sessions[i];
      const [r, g, b] = s.theme.accentColor;

      // Orb glow sprite
      const orb = this.makeOrbSprite(r, g, b);
      orb.position.set(startX + i * orbSpacing, -0.05, -1.5);
      orb.scale.setScalar(0);
      orb.visible = true;
      this.group.add(orb);
      this.orbSprites.push(orb);
      this.allSprites.push(orb);

      // Label below orb
      const label = this.makeTextSprite(
        s.name.toLowerCase(),
        30,
        s.theme.textColor,
        s.theme.textGlow,
      );
      label.position.set(startX + i * orbSpacing, -0.2, -1.5);
      label.scale.set(0, 0, 1);
      this.group.add(label);
      this.orbLabels.push(label);
      this.allSprites.push(label);

      // Stagger appearance
      await this.sleep(150);
      if (this.disposed) return;
      this.animateIn(orb, 0.12, 500);
      this.animateIn(label, 0.3, 500);
    }

    this.selectedIndex = 0;

    const selected = await this.waitForChoice();
    if (this.disposed) return;
    const session = this.sessions[selected];

    // Phase 6: Chosen orb expands, others fade
    question.visible = false;
    for (let i = 0; i < this.orbSprites.length; i++) {
      if (i !== selected) {
        this.animateOut(this.orbSprites[i], 600);
        this.animateOut(this.orbLabels[i], 600);
      }
    }
    this.animateOut(this.orbLabels[selected], 400);

    // Expand chosen orb
    const chosen = this.orbSprites[selected];
    const start = performance.now();
    await new Promise<void>(resolve => {
      const expand = () => {
        if (this.disposed) { resolve(); return; }
        const t = Math.min(1, (performance.now() - start) / 1000);
        const s = 0.12 + t * 1.5;
        chosen.scale.setScalar(s);
        (chosen.material as THREE.SpriteMaterial).opacity = 1 - t * 0.7;
        if (t < 1) requestAnimationFrame(expand);
        else resolve();
      };
      requestAnimationFrame(expand);
    });

    await this.sleep(300);

    // Phase 7: Content warning
    if (session.contentWarning) {
      chosen.visible = false;

      // Split by explicit newlines first, then by word count
      const rawLines = session.contentWarning.split('\n').map(l => l.trim()).filter(l => l);
      const wLines: string[] = [];
      for (const rawLine of rawLines) {
        const words = rawLine.split(/\s+/);
        if (words.length <= 6) {
          wLines.push(rawLine);
        } else {
          for (let i = 0; i < words.length; i += 6) {
            wLines.push(words.slice(i, i + 6).join(' '));
          }
        }
      }

      const lineSpacing = 0.12;
      const totalH = (wLines.length - 1) * lineSpacing;

      // Show all lines at once — no stagger delay
      for (let li = 0; li < wLines.length; li++) {
        const line = this.makeTextSprite(wLines[li], 40, '#cc8090', 'rgba(200,80,100,0.3)');
        const y = 0.15 + totalH / 2 - li * lineSpacing;
        line.position.set(0, y, -1.8);
        line.scale.set(0, 0, 1);
        this.group.add(line);
        this.allSprites.push(line);
        this.animateIn(line, 0.6, 400); // fast, parallel
      }

      await this.sleep(200);

      const confirm = this.makeTextSprite('press space to enter', 32, '#8060aa', 'rgba(128,96,170,0.3)');
      confirm.position.set(0, 0.15 - totalH / 2 - lineSpacing * 1.5, -1.8);
      confirm.scale.set(0, 0, 1);
      this.group.add(confirm);
      this.allSprites.push(confirm);
      await this.animateIn(confirm, 0.5, 400);

      await this.waitForSpace();
      // Fade out all warning lines + confirm
      for (const s of this.allSprites) {
        this.animateOut(s, 600);
      }
      await this.sleep(600);
    }

    // Phase 8: Cleanup and start session
    this.onSelect(session);
    this.dispose();
  }

  // ── Sprite factories ──

  private makeTextSprite(text: string, fontSize: number, color: string, glow: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = `300 ${fontSize}px Georgia, serif`;
    ctx.font = font;

    const metrics = ctx.measureText(text);
    const pad = fontSize * 0.8;
    canvas.width = Math.ceil(metrics.width + pad * 2);
    canvas.height = Math.ceil(fontSize * 2 + pad * 2);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = glow;
    ctx.shadowBlur = 25;
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    ctx.fillText(text, canvas.width / 2, canvas.height / 2); // double for glow

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
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(0.5 * aspect, 0.5, 1);
    return sprite;
  }

  private makeOrbSprite(r: number, g: number, b: number): THREE.Sprite {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Radial gradient orb glow
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.9)`);
    gradient.addColorStop(0.3, `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.4)`);
    gradient.addColorStop(0.7, `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, 0.1)`);
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    return new THREE.Sprite(material);
  }

  // ── Animations ──

  private animateIn(sprite: THREE.Sprite, targetScale: number, durationMs: number): Promise<void> {
    const mat = sprite.material as THREE.SpriteMaterial;
    const aspect = sprite.scale.x / Math.max(sprite.scale.y, 0.001) || 1;
    const start = performance.now();

    return new Promise(resolve => {
      const tick = () => {
        if (this.disposed) { resolve(); return; }
        const t = Math.min(1, (performance.now() - start) / durationMs);
        const ease = 1 - (1 - t) * (1 - t); // ease out
        mat.opacity = ease * 0.9;

        // For orbs (aspect ~1), scale uniformly; for text, keep aspect
        if (Math.abs(aspect) < 0.01 || Math.abs(aspect - 1) < 0.3) {
          sprite.scale.setScalar(targetScale * ease);
        } else {
          sprite.scale.set(targetScale * aspect * ease, targetScale * ease, 1);
        }

        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
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

  private waitForSpace(): Promise<void> {
    return new Promise(resolve => {
      const handler = (e: KeyboardEvent) => {
        if (e.code === 'Space') {
          e.preventDefault();
          window.removeEventListener('keydown', handler);
          this.keyHandler = null;
          resolve();
        }
      };
      this.keyHandler = handler;
      window.addEventListener('keydown', handler);
    });
  }

  private waitForChoice(): Promise<number> {
    return new Promise(resolve => {
      // Keyboard
      const keyHandler = (e: KeyboardEvent) => {
        e.preventDefault();
        if (e.code === 'ArrowLeft' || e.code === 'ArrowUp' || e.code === 'KeyA' || e.code === 'KeyW') {
          this.selectedIndex = (this.selectedIndex - 1 + this.sessions.length) % this.sessions.length;
        } else if (e.code === 'ArrowRight' || e.code === 'ArrowDown' || e.code === 'KeyD' || e.code === 'KeyS') {
          this.selectedIndex = (this.selectedIndex + 1) % this.sessions.length;
        } else if (e.code === 'Space' || e.code === 'Enter') {
          cleanup();
          resolve(this.selectedIndex);
        }
      };

      // Click/tap raycasting
      const clickHandler = (e: MouseEvent) => {
        this.pointer.x = (e.clientX / this.canvas.clientWidth) * 2 - 1;
        this.pointer.y = -(e.clientY / this.canvas.clientHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.camera);

        const hits = this.raycaster.intersectObjects(this.orbSprites);
        if (hits.length > 0) {
          const idx = this.orbSprites.indexOf(hits[0].object as THREE.Sprite);
          if (idx >= 0) {
            this.selectedIndex = idx;
            cleanup();
            resolve(idx);
          }
        }
      };

      const cleanup = () => {
        window.removeEventListener('keydown', keyHandler);
        this.canvas.removeEventListener('click', clickHandler);
        this.keyHandler = null;
        this.clickHandler = null;
      };

      this.keyHandler = keyHandler;
      this.clickHandler = clickHandler;
      window.addEventListener('keydown', keyHandler);
      this.canvas.addEventListener('click', clickHandler);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
