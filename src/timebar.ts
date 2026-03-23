/**
 * Timeline scrubber — a dev/debug widget for navigating the session timeline.
 *
 * Shows:
 *   - Full timeline bar with segment boundaries
 *   - Current position indicator (draggable)
 *   - Segment names annotated
 *   - Elapsed / total time
 *   - Play/pause button
 *
 * Toggle: press 't' key
 */

import type { Timeline, TimelineSegment } from './timeline';

export class Timebar {
  private el: HTMLDivElement;
  private bar: HTMLDivElement;
  private cursor: HTMLDivElement;
  private timeLabel: HTMLSpanElement;
  private segLabels: HTMLDivElement;
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
          <div class="timebar-segments" id="timebar-segments"></div>
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
    this.segLabels = this.el.querySelector('#timebar-segments')!;

    // Style the track
    this.bar.style.cssText = `
      flex: 1; height: 20px; background: rgba(255,255,255,0.08); border-radius: 3px;
      position: relative; cursor: pointer; margin: 0 8px; overflow: hidden;
    `;
    this.cursor.style.cssText = `
      position: absolute; top: 0; bottom: 0; width: 3px; background: #c8a0ff;
      border-radius: 1px; pointer-events: none; z-index: 2;
    `;
    this.segLabels.style.cssText = `
      position: absolute; top: 0; bottom: 0; left: 0; right: 0; z-index: 1;
    `;

    // Style inner container
    const inner = this.el.querySelector('.timebar-inner') as HTMLDivElement;
    inner.style.cssText = 'display: flex; align-items: center; gap: 8px;';

    // Style play/pause button
    const ppBtn = this.el.querySelector('#timebar-pp') as HTMLButtonElement;
    ppBtn.style.cssText = `
      background: none; border: 1px solid #666; color: #ccc; padding: 2px 6px;
      cursor: pointer; border-radius: 3px; font-size: 10px; min-width: 24px;
    `;

    // Bind events
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

    // Toggle with 't' key
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey) {
        this.toggle();
      }
    });

    // Stop pointer events from reaching canvas
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => e.stopPropagation());
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
    if (this.visible) this.buildSegments();
  }

  show(): void {
    this.visible = true;
    this.el.style.display = 'block';
    this.buildSegments();
  }

  hide(): void {
    this.visible = false;
    this.el.style.display = 'none';
  }

  /** Call every frame to update cursor position + time label */
  update(): void {
    if (!this.visible || !this.timeline.started) return;

    const pos = this.timeline.position;
    const total = this.timeline.totalDuration;
    const pct = total > 0 ? (pos / total) * 100 : 0;

    this.cursor.style.left = `${pct}%`;
    this.timeLabel.textContent = `${this.fmt(pos)} / ${this.fmt(total)}`;

    // Update play/pause button
    const ppBtn = this.el.querySelector('#timebar-pp') as HTMLButtonElement;
    ppBtn.textContent = this.timeline.paused ? '▶' : '⏸';
  }

  /** Rebuild segment markers (call when timeline is built or changes) */
  buildSegments(): void {
    this.segLabels.innerHTML = '';
    const total = this.timeline.totalDuration;
    if (total === 0) return;

    for (let i = 0; i < this.timeline.segmentCount; i++) {
      const seg = this.timeline.allSegments[i];
      if (!seg) continue;

      const left = (seg.start / total) * 100;
      const width = (seg.duration / total) * 100;

      const div = document.createElement('div');
      div.style.cssText = `
        position: absolute; top: 0; bottom: 0;
        left: ${left}%; width: ${width}%;
        border-right: 1px solid rgba(255,255,255,0.2);
        display: flex; align-items: center; justify-content: center;
        font-size: 9px; color: rgba(255,255,255,0.4); overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; padding: 0 2px;
      `;
      div.textContent = seg.stage.name;
      div.title = `${seg.stage.name} (${this.fmt(seg.duration)})${seg.hasAudio ? ' 🎵' : ''}`;
      this.segLabels.appendChild(div);
    }
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
