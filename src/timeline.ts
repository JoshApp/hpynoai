/**
 * Timeline — single source of truth for session progression.
 *
 * Like a media player: one monotonic clock, everything derives from position.
 * Supports seeking, tab-away recovery, audio-driven clock, and clean state.
 *
 * Position sources (in priority order):
 *   1. Bound audio element's currentTime + segment offset (pre-recorded sessions)
 *   2. Wall clock with pause compensation (TTS / no-audio sessions)
 *
 * All text, interactions, stage changes, and intensity are pre-computed at build().
 * update() just reads the clock and fires what's due. No timers, no races.
 */

import { log } from './logger';
import type { SessionStage, Interaction } from './session';

// ── Types ────────────────────────────────────────────────────────

export interface TimelineSegment {
  index: number;
  stage: SessionStage;
  start: number;           // absolute start in timeline (seconds)
  end: number;             // absolute end
  duration: number;
  hasAudio: boolean;
}

export interface TimelineEvent {
  t: number;               // absolute time
  type: 'text' | 'interaction' | 'segment-start';
  text?: string;
  interaction?: Interaction;
  segmentIndex: number;
}

export interface TimelineState {
  position: number;
  segment: TimelineSegment;
  segmentIndex: number;
  segmentElapsed: number;
  segmentProgress: number;  // 0-1
  intensity: number;        // includes fractionation + interpolation
  spiralSpeed: number;
  breathCycle: number;
  breathPattern: SessionStage['breathPattern'];
  complete: boolean;
}

// ── Intensity helpers ────────────────────────────────────────────

const FRAC_HOLD = 4;    // seconds to hold the fractionation dip
const FRAC_RAMP = 3;    // seconds to ramp back up

function calcIntensity(
  segments: TimelineSegment[],
  segIdx: number,
  segElapsed: number,
  segProgress: number,
): number {
  const seg = segments[segIdx];
  const base = seg.stage.intensity;

  // Fractionation dip at stage start
  let intensity = base;
  const dip = seg.stage.fractionationDip;
  if (dip != null && segElapsed < FRAC_HOLD + FRAC_RAMP) {
    if (segElapsed < FRAC_HOLD) {
      intensity = dip;
    } else {
      const rampT = (segElapsed - FRAC_HOLD) / FRAC_RAMP;
      intensity = dip + (base - dip) * Math.min(1, rampT);
    }
  }

  // Interpolate toward next stage in the last 15%
  if (segProgress > 0.85 && segIdx < segments.length - 1) {
    const blendT = (segProgress - 0.85) / 0.15;
    const nextIntensity = segments[segIdx + 1].stage.intensity;
    intensity += (nextIntensity - intensity) * blendT;
  }

  return intensity;
}

// ── Timeline ────────────────────────────────────────────────────

export class Timeline {
  private segments: TimelineSegment[] = [];
  private events: TimelineEvent[] = [];
  private _totalDuration = 0;

  // Clock state
  private _position = 0;
  private _started = false;
  private _paused = false;
  private wallStartTime = 0;
  private pauseStartTime = 0;
  private totalPauseDuration = 0;
  private speedMultiplier = 1;

  // Audio binding
  private audioElement: HTMLAudioElement | null = null;
  private audioSegmentStart = 0; // timeline time where audio segment begins

  // Event tracking
  private currentSegmentIndex = 0;
  private nextEventIndex = 0;
  private firedInteractions = new Set<number>();

  // Callbacks
  private _onSegmentChange: ((seg: TimelineSegment, prev: TimelineSegment | null) => void) | null = null;
  private _onText: ((text: string, seg: TimelineSegment) => void) | null = null;
  private _onInteraction: ((interaction: Interaction, seg: TimelineSegment) => void) | null = null;
  private _onComplete: (() => void) | null = null;
  private _completeFired = false;

  // ══════════════════════════════════════════════════════════════
  // BUILD — pre-compute the entire timeline from session config
  // ══════════════════════════════════════════════════════════════

  build(
    stages: SessionStage[],
    hasAudio: (name: string) => boolean,
    audioDuration: (name: string) => number | null,
  ): void {
    this.segments = [];
    this.events = [];
    let cursor = 0;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stageHasAudio = hasAudio(stage.name);
      const dur = audioDuration(stage.name) ?? stage.duration;

      const segment: TimelineSegment = {
        index: i,
        stage,
        start: cursor,
        end: cursor + dur,
        duration: dur,
        hasAudio: stageHasAudio,
      };
      this.segments.push(segment);

      // Segment-start event
      this.events.push({ t: cursor, type: 'segment-start', segmentIndex: i });

      // Pre-compute text events — cycle through stage.texts[] at textInterval
      if (stage.texts.length > 0 && !stageHasAudio) {
        // Only schedule text for non-audio stages (audio stages use word timestamps)
        const interval = stage.textInterval ?? 7;
        let textTime = cursor + interval;
        let textIdx = 0;
        while (textTime < cursor + dur - 1) { // stop 1s before end
          this.events.push({
            t: textTime,
            type: 'text',
            text: stage.texts[textIdx % stage.texts.length],
            segmentIndex: i,
          });
          textIdx++;
          textTime += interval;
        }
      }

      // Pre-compute interaction events
      if (stage.interactions) {
        for (const interaction of stage.interactions) {
          this.events.push({
            t: cursor + (interaction.triggerAt ?? 0),
            type: 'interaction',
            interaction,
            segmentIndex: i,
          });
        }
      }

      cursor += dur;
    }

    this.events.sort((a, b) => a.t - b.t);
    this._totalDuration = cursor;

    log.info('timeline', `Built: ${this.segments.length} segments, ${this.events.length} events, ${cursor.toFixed(1)}s`);
  }

  // ══════════════════════════════════════════════════════════════
  // PLAYBACK CONTROL
  // ══════════════════════════════════════════════════════════════

  start(): void {
    this._started = true;
    this._paused = false;
    this._completeFired = false;
    this._position = 0;
    this.currentSegmentIndex = 0;
    this.nextEventIndex = 0;
    this.firedInteractions.clear();
    this.wallStartTime = performance.now() / 1000;
    this.totalPauseDuration = 0;
    this.audioElement = null;
    this.audioSegmentStart = 0;

    if (this.segments.length > 0 && this._onSegmentChange) {
      this._onSegmentChange(this.segments[0], null);
    }

    log.info('timeline', 'Started');
  }

  pause(): void {
    if (this._paused) return;
    this._position = this.readClock(); // snapshot
    this._paused = true;
    this.pauseStartTime = performance.now() / 1000;
    log.info('timeline', `Paused at ${this._position.toFixed(1)}s`);
  }

  resume(): void {
    if (!this._paused) return;
    const pauseDur = performance.now() / 1000 - this.pauseStartTime;
    this.totalPauseDuration += pauseDur;
    this._paused = false;
    log.info('timeline', `Resumed (was paused ${pauseDur.toFixed(1)}s)`);
  }

  stop(): void {
    this._started = false;
    this._paused = false;
    this.audioElement = null;
    log.info('timeline', 'Stopped');
  }

  /** Seek to absolute time. Recalculates everything. */
  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this._totalDuration));
    this._position = clamped;

    // Reset wall clock baseline
    this.wallStartTime = performance.now() / 1000 - clamped;
    this.totalPauseDuration = 0;

    // Find segment
    const newIdx = this.findSegment(clamped);
    const changed = newIdx !== this.currentSegmentIndex;
    const prev = changed ? this.segments[this.currentSegmentIndex] : null;
    this.currentSegmentIndex = newIdx;

    // Reset events — skip everything before the seek point
    this.nextEventIndex = 0;
    this.firedInteractions.clear();
    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].t <= clamped) {
        this.nextEventIndex = i + 1;
        if (this.events[i].type === 'interaction') {
          this.firedInteractions.add(i);
        }
      } else {
        break;
      }
    }

    this._completeFired = false;

    if (changed && this._onSegmentChange) {
      this._onSegmentChange(this.segments[newIdx], prev);
    }

    log.info('timeline', `Seeked to ${clamped.toFixed(1)}s → segment ${newIdx}`);
  }

  /** Dev mode: change playback speed (1 = normal) */
  setSpeed(s: number): void {
    // Snapshot position before speed change so it doesn't jump
    this._position = this.readClock();
    this.wallStartTime = performance.now() / 1000 - this._position;
    this.totalPauseDuration = 0;
    this.speedMultiplier = s;
  }

  // ══════════════════════════════════════════════════════════════
  // AUDIO BINDING — narration tells us when audio starts/stops
  // ══════════════════════════════════════════════════════════════

  /**
   * Bind a playing audio element as clock source.
   * The timeline position becomes: segmentStart + audio.currentTime
   *
   * @param audio The HTMLAudioElement currently playing
   * @param segmentStart The timeline time where this segment begins
   */
  bindAudio(audio: HTMLAudioElement, segmentStart: number): void {
    this.audioElement = audio;
    this.audioSegmentStart = segmentStart;
    log.info('timeline', `Audio bound at segment ${segmentStart.toFixed(1)}s`);
  }

  /** Unbind audio — snapshot position and fall back to wall clock */
  unbindAudio(): void {
    if (!this.audioElement) return;
    this._position = this.readClock();
    this.audioElement = null;
    this.wallStartTime = performance.now() / 1000 - this._position;
    this.totalPauseDuration = 0;
    log.info('timeline', `Audio unbound at ${this._position.toFixed(1)}s`);
  }

  /** Called by narration when stage audio ends — advance past the segment */
  audioEnded(): void {
    this.unbindAudio();
    // Position is now at the end of the audio, update() will advance the segment
  }

  // ══════════════════════════════════════════════════════════════
  // UPDATE — call every frame. Returns derived state.
  // ══════════════════════════════════════════════════════════════

  update(): TimelineState | null {
    if (!this._started || this.segments.length === 0) return null;
    if (this._paused) {
      // Still return state so the renderer can draw the frozen frame
      return this.deriveState(this._position);
    }

    const pos = this.readClock();

    // Detect segment change
    const seg = this.segments[this.currentSegmentIndex];
    if (pos >= seg.end && this.currentSegmentIndex < this.segments.length - 1) {
      const prev = seg;
      this.currentSegmentIndex++;
      const next = this.segments[this.currentSegmentIndex];
      if (this._onSegmentChange) {
        this._onSegmentChange(next, prev);
      }
    }

    // Fire due events
    this.fireEvents(pos);

    // Completion
    if (pos >= this._totalDuration && !this._completeFired) {
      this._completeFired = true;
      if (this._onComplete) this._onComplete();
    }

    return this.deriveState(pos);
  }

  // ══════════════════════════════════════════════════════════════
  // STATE DERIVATION — pure function from position
  // ══════════════════════════════════════════════════════════════

  private deriveState(pos: number): TimelineState {
    const seg = this.segments[this.currentSegmentIndex];
    const elapsed = Math.max(0, pos - seg.start);
    const progress = Math.min(1, elapsed / seg.duration);

    return {
      position: pos,
      segment: seg,
      segmentIndex: this.currentSegmentIndex,
      segmentElapsed: elapsed,
      segmentProgress: progress,
      intensity: calcIntensity(this.segments, this.currentSegmentIndex, elapsed, progress),
      spiralSpeed: seg.stage.spiralSpeed ?? 1,
      breathCycle: seg.stage.breathCycle ?? 7,
      breathPattern: seg.stage.breathPattern,
      complete: pos >= this._totalDuration,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // GETTERS
  // ══════════════════════════════════════════════════════════════

  /** Current position — THE source of truth */
  get position(): number {
    if (this._paused) return this._position;
    return this.readClock();
  }

  get started(): boolean { return this._started; }
  get paused(): boolean { return this._paused; }
  get totalDuration(): number { return this._totalDuration; }
  get currentSegment(): TimelineSegment { return this.segments[this.currentSegmentIndex]; }
  get currentIndex(): number { return this.currentSegmentIndex; }
  get segmentCount(): number { return this.segments.length; }
  get allSegments(): readonly TimelineSegment[] { return this.segments; }
  get isAudioBound(): boolean { return this.audioElement !== null; }

  // ══════════════════════════════════════════════════════════════
  // CALLBACKS
  // ══════════════════════════════════════════════════════════════

  onSegmentChange(fn: (seg: TimelineSegment, prev: TimelineSegment | null) => void): void {
    this._onSegmentChange = fn;
  }

  onText(fn: (text: string, seg: TimelineSegment) => void): void {
    this._onText = fn;
  }

  onInteraction(fn: (interaction: Interaction, seg: TimelineSegment) => void): void {
    this._onInteraction = fn;
  }

  onComplete(fn: () => void): void {
    this._onComplete = fn;
  }

  // ══════════════════════════════════════════════════════════════
  // INTERNAL
  // ══════════════════════════════════════════════════════════════

  /** Read the current clock — audio or wall */
  private readClock(): number {
    // Audio is the primary clock when bound
    if (this.audioElement && !this.audioElement.paused) {
      return this.audioSegmentStart + this.audioElement.currentTime;
    }

    // Wall clock with pause compensation and speed multiplier
    const wallNow = performance.now() / 1000;
    const rawElapsed = wallNow - this.wallStartTime - this.totalPauseDuration;
    return rawElapsed * this.speedMultiplier;
  }

  private findSegment(t: number): number {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (t >= this.segments[i].start) return i;
    }
    return 0;
  }

  private fireEvents(pos: number): void {
    while (this.nextEventIndex < this.events.length) {
      const evt = this.events[this.nextEventIndex];
      if (evt.t > pos) break;

      this.nextEventIndex++;

      switch (evt.type) {
        case 'text':
          if (this._onText && evt.text) {
            this._onText(evt.text, this.segments[evt.segmentIndex]);
          }
          break;

        case 'interaction':
          if (this._onInteraction && evt.interaction && !this.firedInteractions.has(this.nextEventIndex - 1)) {
            this.firedInteractions.add(this.nextEventIndex - 1);
            this._onInteraction(evt.interaction, this.segments[evt.segmentIndex]);
          }
          break;

        case 'segment-start':
          // Handled by segment change detection in update()
          break;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // CLEANUP
  // ══════════════════════════════════════════════════════════════

  reset(): void {
    this._started = false;
    this._paused = false;
    this._position = 0;
    this._completeFired = false;
    this.currentSegmentIndex = 0;
    this.nextEventIndex = 0;
    this.firedInteractions.clear();
    this.audioElement = null;
    this.segments = [];
    this.events = [];
    this._totalDuration = 0;
  }
}
