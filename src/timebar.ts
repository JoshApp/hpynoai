/**
 * Timeline scrubber — a dev/debug widget for navigating the session timeline.
 *
 * Shows:
 *   - Full timeline bar with block boundaries (color-coded by type)
 *   - Current position indicator (draggable)
 *   - Block names annotated
 *   - Elapsed / total time
 *   - Play/pause button
 *
 * Toggle: press 't' key
 */

import type { Timeline, TimelineBlock } from './timeline';

const CLIP_COLORS: Record<string, string> = {
  'narration-audio':  'rgba(100, 140, 255, 0.3)',
  'narration-tts':    'rgba(100, 140, 255, 0.15)',
  'breathing-intro':  'rgba(80, 220, 160, 0.2)',
  'breathing-core':   'rgba(80, 220, 160, 0.3)',
  'breathing-outro':  'rgba(80, 220, 160, 0.2)',
  'interaction':      'rgba(255, 180, 80, 0.25)',
  'transition':       'rgba(255, 255, 255, 0.08)',
};

export class Timebar {
  private el: HTMLDivElement;
  private bar: HTMLDivElement;
  private cursor: HTMLDivElement;
  private timeLabel: HTMLSpanElement;
  private blockLabels: HTMLDivElement;
  private timeline: Timeline;
  private visible = false;
  private dragging = false;

  constructor(timeline: Timeline) {
    this.timeline = timeline;

    this.el = document.createElement('div');
    this.el.id = 'timebar';
    this.el.innerHTML = `
      <div class="timebar-inner">
        <button class="timebar-playpause" id="timebar-pp">▶</button>
        <div class="timebar-track" id="timebar-track">
          <div class="timebar-blocks" id="timebar-blocks"></div>
          <div class="timebar-cursor" id="timebar-cursor"></div>
        </div>
        <span class="timebar-time" id="timebar-time">0:00 / 0:00</span>
      </div>
    `;
    this.el.style.cssText = `
      position: fixed; bottom: 0; left: 0; right: 0; z-index: 9999;
      background: rgba(0,0,0,0.85); padding: 6px 12px; display: none;
      font: 11px monospace; color: #aaa; user-select: none;
    `;

    document.body.appendChild(this.el);

    this.bar = this.el.querySelector('#timebar-track')!;
    this.cursor = this.el.querySelector('#timebar-cursor')!;
    this.timeLabel = this.el.querySelector('#timebar-time')!;
    this.blockLabels = this.el.querySelector('#timebar-blocks')!;

    this.bar.style.cssText = `
      flex: 1; height: 20px; background: rgba(255,255,255,0.08); border-radius: 3px;
      position: relative; cursor: pointer; margin: 0 8px; overflow: hidden;
    `;
    this.cursor.style.cssText = `
      position: absolute; top: 0; bottom: 0; width: 3px; background: #c8a0ff;
      border-radius: 1px; pointer-events: none; z-index: 2;
    `;
    this.blockLabels.style.cssText = `
      position: absolute; top: 0; bottom: 0; left: 0; right: 0; z-index: 1;
    `;

    const inner = this.el.querySelector('.timebar-inner') as HTMLDivElement;
    inner.style.cssText = 'display: flex; align-items: center; gap: 8px;';

    const ppBtn = this.el.querySelector('#timebar-pp') as HTMLButtonElement;
    ppBtn.style.cssText = `
      background: none; border: 1px solid #666; color: #ccc; padding: 2px 6px;
      cursor: pointer; border-radius: 3px; font-size: 10px; min-width: 24px;
    `;

    ppBtn.addEventListener('click', () => {
      if (this.timeline.paused) {
        this.timeline.resume();
      } else {
        this.timeline.pause();
      }
    });

    this.bar.addEventListener('mousedown', (e) => this.startDrag(e));
    document.addEventListener('mousemove', (e) => { if (this.dragging) this.doDrag(e); });
    document.addEventListener('mouseup', () => { this.dragging = false; });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey) {
        this.toggle();
      }
    });

    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => e.stopPropagation());
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
    if (this.visible) this.buildBlocks();
  }

  show(): void {
    this.visible = true;
    this.el.style.display = 'block';
    this.buildBlocks();
  }

  hide(): void {
    this.visible = false;
    this.el.style.display = 'none';
  }

  update(): void {
    if (!this.visible || !this.timeline.started) return;

    const pos = this.timeline.position;
    const total = this.timeline.totalDuration;
    const pct = total > 0 ? (pos / total) * 100 : 0;

    this.cursor.style.left = `${pct}%`;
    this.timeLabel.textContent = `${this.fmt(pos)} / ${this.fmt(total)}`;

    const ppBtn = this.el.querySelector('#timebar-pp') as HTMLButtonElement;
    ppBtn.textContent = this.timeline.paused ? '▶' : '⏸';
  }

  /** Rebuild block markers (call when timeline is built) */
  buildBlocks(): void {
    this.blockLabels.innerHTML = '';
    const total = this.timeline.totalDuration;
    if (total === 0) return;

    for (let i = 0; i < this.timeline.blockCount; i++) {
      const block = this.timeline.allBlocks[i];
      if (!block) continue;

      const left = (block.start / total) * 100;
      const width = (block.duration / total) * 100;
      const bg = CLIP_COLORS[block.clipType] ?? CLIP_COLORS.transition;

      const div = document.createElement('div');
      div.style.cssText = `
        position: absolute; top: 0; bottom: 0;
        left: ${left}%; width: ${width}%;
        background: ${bg};
        border-right: 1px solid rgba(255,255,255,0.2);
        display: flex; align-items: center; justify-content: center;
        font-size: 9px; color: rgba(255,255,255,0.5); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; padding: 0 2px;
      `;
      div.textContent = this.blockLabel(block);
      div.title = `${block.clipType}: ${block.stage.name} (${this.fmt(block.duration)})`;
      this.blockLabels.appendChild(div);
    }
  }

  private blockLabel(block: TimelineBlock): string {
    // Simple label from clipType — no access to block.data needed
    if (block.clipType.startsWith('breathing')) return `🫁 ${block.clipType.split('-')[1]}`;
    if (block.clipType === 'interaction') return '⚡';
    if (block.clipType === 'transition') return '…';
    return block.stage.name;
  }

  private startDrag(e: MouseEvent): void {
    this.dragging = true;
    this.doDrag(e);
  }

  private doDrag(e: MouseEvent): void {
    const rect = this.bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const t = pct * this.timeline.totalDuration;
    this.timeline.seek(t);
  }

  private fmt(s: number): string {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  destroy(): void {
    this.el.remove();
  }
}
