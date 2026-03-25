/**
 * InputController — centralized input handling for HPYNO.
 *
 * Listens to raw DOM events (mouse, touch, keyboard) and emits
 * semantic actions through the event bus. Systems subscribe to
 * actions they care about — no direct DOM listeners needed.
 *
 * Semantic actions:
 *   input:confirm      — space / enter / tap (not during hold)
 *   input:back          — escape
 *   input:left          — arrow left / A / swipe right
 *   input:right         — arrow right / D / swipe left
 *   input:hold-start    — space down / touch start (on canvas)
 *   input:hold-end      — space up / touch end
 *   input:swipe         — horizontal/vertical swipe with direction + delta
 *   input:pointer-move  — normalized pointer position (-1 to 1)
 *   input:tap           — short tap/click with position (NDC + screen)
 *
 * Pointer state is also available as direct reads for the render loop:
 *   input.pointer  — { x, y } in NDC
 *   input.isHolding — true while space/touch is held
 */

import type { EventBus } from './events';

const SWIPE_THRESHOLD = 40;  // px minimum for a swipe
const TAP_MAX_MOVE = 15;     // px max movement for a tap
const TAP_MAX_TIME = 400;    // ms max duration for a tap

export class InputController {
  // Direct-read state for render loop (no events needed)
  readonly pointer = { x: 0, y: 0 };
  private _isHolding = false;

  private bus: EventBus;
  private canvas: HTMLCanvasElement;
  private cleanupFns: Array<() => void> = [];

  // Touch tracking
  private touchStartX = 0;
  private touchStartY = 0;
  private touchStartTime = 0;
  private spaceHeld = false;

  constructor(bus: EventBus, canvas: HTMLCanvasElement) {
    this.bus = bus;
    this.canvas = canvas;
    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  get isHolding(): boolean {
    return this._isHolding;
  }

  // ── Keyboard ─────────────────────────────────────────────────

  private bindKeyboard(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input field
      if ((e.target as HTMLElement).tagName === 'INPUT') return;

      switch (e.code) {
        case 'Space':
        case 'Enter':
          e.preventDefault();
          if (!this.spaceHeld) {
            this.spaceHeld = true;
            this._isHolding = true;
            this.bus.emit('input:hold-start', {});
            this.bus.emit('input:confirm', {});
          }
          break;
        case 'Escape':
          e.preventDefault();
          this.bus.emit('input:back', {});
          break;
        case 'ArrowLeft':
        case 'KeyA':
          e.preventDefault();
          this.bus.emit('input:left', {});
          break;
        case 'ArrowRight':
        case 'KeyD':
          e.preventDefault();
          this.bus.emit('input:right', {});
          break;
        case 'ArrowUp':
        case 'KeyW':
          e.preventDefault();
          this.bus.emit('input:left', {}); // up = left in carousel
          break;
        case 'ArrowDown':
        case 'KeyS':
          e.preventDefault();
          this.bus.emit('input:right', {}); // down = right in carousel
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        this.spaceHeld = false;
        this._isHolding = false;
        this.bus.emit('input:hold-end', {});
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this.cleanupFns.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
    );
  }

  // ── Mouse ────────────────────────────────────────────────────

  private bindMouse(): void {
    const onMouseMove = (e: MouseEvent) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    };

    const onClick = (e: MouseEvent) => {
      const x = (e.clientX / window.innerWidth) * 2 - 1;
      const y = -(e.clientY / window.innerHeight) * 2 + 1;
      this.bus.emit('input:tap', { x, y, clientX: e.clientX, clientY: e.clientY });
      this.bus.emit('input:confirm', {});
    };

    const onMouseDown = () => {
      this._isHolding = true;
      this.bus.emit('input:hold-start', {});
    };

    const onMouseUp = () => {
      this._isHolding = false;
      this.bus.emit('input:hold-end', {});
    };

    document.addEventListener('mousemove', onMouseMove);
    this.canvas.addEventListener('click', onClick);
    this.canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    this.cleanupFns.push(
      () => document.removeEventListener('mousemove', onMouseMove),
      () => this.canvas.removeEventListener('click', onClick),
      () => this.canvas.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
    );
  }

  // ── Touch ────────────────────────────────────────────────────

  private bindTouch(): void {
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      const t = e.touches[0];
      this.touchStartX = t.clientX;
      this.touchStartY = t.clientY;
      this.touchStartTime = performance.now();

      // Update pointer
      this.pointer.x = (t.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(t.clientY / window.innerHeight) * 2 + 1;

      this._isHolding = true;
      this.bus.emit('input:hold-start', {});
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      const t = e.touches[0];
      this.pointer.x = (t.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = -(t.clientY / window.innerHeight) * 2 + 1;
    };

    const onTouchEnd = (e: TouchEvent) => {
      this._isHolding = false;
      this.bus.emit('input:hold-end', {});

      if (e.changedTouches.length === 0) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - this.touchStartX;
      const dy = t.clientY - this.touchStartY;
      const elapsed = performance.now() - this.touchStartTime;

      // Swipe detection
      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
        const dir = dx < 0 ? 'left' : 'right';
        // Swipe left = navigate right, swipe right = navigate left
        this.bus.emit(dir === 'left' ? 'input:right' : 'input:left', {});
        return;
      }
      if (Math.abs(dy) > SWIPE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
        const dir = dy < 0 ? 'up' : 'down';
        return;
      }

      // Tap detection (short touch, minimal movement)
      if (Math.abs(dx) < TAP_MAX_MOVE && Math.abs(dy) < TAP_MAX_MOVE && elapsed < TAP_MAX_TIME) {
        const x = (t.clientX / window.innerWidth) * 2 - 1;
        const y = -(t.clientY / window.innerHeight) * 2 + 1;
        this.bus.emit('input:tap', { x, y, clientX: t.clientX, clientY: t.clientY });
        this.bus.emit('input:confirm', {});
      }
    };

    this.canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    this.canvas.addEventListener('touchend', onTouchEnd);
    this.cleanupFns.push(
      () => this.canvas.removeEventListener('touchstart', onTouchStart),
      () => document.removeEventListener('touchmove', onTouchMove),
      () => this.canvas.removeEventListener('touchend', onTouchEnd),
    );
  }

  // ── Cleanup ──────────────────────────────────────────────────

  dispose(): void {
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
  }
}
