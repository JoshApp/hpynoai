/**
 * Timeline — NLE-style transport + clip dispatch.
 *
 * The timeline is a flat array of clips (blocks). Each clip has a type and data.
 * The transport manages position/play/pause/seek. On each frame, it dispatches
 * to the clip's derive function to get a ClipFrame, then merges with transport
 * state to produce TimelineState.
 *
 * Clip-type-specific logic lives in clips.ts. This file has ZERO switch
 * statements on clip type.
 */

import { log } from './logger';
import { realtimeClock, type Clock } from './clock';
import type { SessionStage, Interaction, TimelineBlock } from './session';
import {
  clipDerivers, cycleDuration,
  type ClipFrame, type ClipType, type TextStyle,
  type NarrationAudioData, type NarrationTTSData,
  type BreathIntroData, type BreathCoreData, type BreathOutroData,
  type InteractionClipData, type InterludeData,
} from './clips';

// Re-export for consumers
export type { TimelineBlock } from './session';
export type { ClipFrame, ClipType, TextStyle } from './clips';

// ── TimelineState = ClipFrame + transport fields ─────────────────

export interface TimelineState extends ClipFrame {
  position: number;
  block: TimelineBlock;
  blockIndex: number;
  blockElapsed: number;
  blockProgress: number;
  intensity: number;
  spiralSpeed: number;
  blockJustChanged: boolean;
  seeked: boolean;
  complete: boolean;
}

// ── Intensity helpers ────────────────────────────────────────────

const FRAC_HOLD = 4;
const FRAC_RAMP = 3;

function calcIntensity(blocks: TimelineBlock[], blockIdx: number, pos: number): number {
  const block = blocks[blockIdx];
  const base = block.stage.intensity;
  let intensity = base;

  // Fractionation dip at stage start
  const dip = block.stage.fractionationDip;
  if (dip != null) {
    let stageStart = block.start;
    for (let i = blockIdx - 1; i >= 0; i--) {
      if (blocks[i].stageIndex === block.stageIndex) stageStart = blocks[i].start;
      else break;
    }
    const stageElapsed = pos - stageStart;
    if (stageElapsed < FRAC_HOLD + FRAC_RAMP) {
      intensity = stageElapsed < FRAC_HOLD
        ? dip
        : dip + (base - dip) * Math.min(1, (stageElapsed - FRAC_HOLD) / FRAC_RAMP);
    }
  }

  // Blend toward next stage in last 15% of the final block of this stage
  let lastBlockForStage = blockIdx;
  for (let i = blockIdx + 1; i < blocks.length; i++) {
    if (blocks[i].stageIndex === block.stageIndex) lastBlockForStage = i;
    else break;
  }
  if (blockIdx === lastBlockForStage) {
    let stageStart = block.start;
    for (let i = blockIdx - 1; i >= 0; i--) {
      if (blocks[i].stageIndex === block.stageIndex) stageStart = blocks[i].start;
      else break;
    }
    const stageDuration = blocks[lastBlockForStage].end - stageStart;
    const stageProgress = stageDuration > 0 ? (pos - stageStart) / stageDuration : 1;
    if (stageProgress > 0.85 && lastBlockForStage < blocks.length - 1) {
      const blendT = (stageProgress - 0.85) / 0.15;
      intensity += (blocks[lastBlockForStage + 1].stage.intensity - intensity) * blendT;
    }
  }

  return intensity;
}

// ── Build constants ──────────────────────────────────────────────

const BREATHING_INTRO_DURATION = 5;
const BREATHING_OUTRO_DURATION = 5;
const DEFAULT_BREATHS = 4;
const INTERACTION_MIN_DURATION = 5;

// ── Timeline (transport) ─────────────────────────────────────────

export class Timeline {
  private blocks: TimelineBlock[] = [];
  private _totalDuration = 0;
  private clock: Clock;

  // Transport state
  private _position = 0;
  private _started = false;
  private _paused = false;
  private wallStartTime = 0;
  private pauseStartTime = 0;
  private totalPauseDuration = 0;
  private speedMultiplier = 1;

  constructor(clock?: Clock) {
    this.clock = clock ?? realtimeClock;
  }

  // Per-frame flags
  private _prevBlockIndex = -1;
  private _seeked = false;

  // Audio binding
  private audioElement: HTMLAudioElement | null = null;
  private audioBlockStart = 0;

  // Block tracking
  private currentBlockIndex = 0;
  private _completeFired = false;
  private _interactionMode = true;

  // ══════════════════════════════════════════════════════════════
  // BUILD — transform session stages into flat clip array
  // ══════════════════════════════════════════════════════════════

  build(
    stages: SessionStage[],
    hasAudio: (name: string) => boolean,
    audioDuration: (name: string) => number | null,
  ): void {
    this.blocks = [];
    let cursor = 0;

    for (let si = 0; si < stages.length; si++) {
      const stage = stages[si];
      const stageHasAudio = hasAudio(stage.name);
      const stageDur = audioDuration(stage.name) ?? stage.duration;
      const interactions = [...(stage.interactions ?? [])].sort((a, b) => a.triggerAt - b.triggerAt);

      let stageOffset = 0;

      for (const ix of interactions) {
        // Narration before this interaction
        if (ix.triggerAt > stageOffset) {
          cursor = this.addBlock(cursor, ix.triggerAt - stageOffset, stage, si,
            stageHasAudio ? 'narration-audio' : 'narration-tts',
            stageHasAudio
              ? { stageName: stage.name, audioOffset: stageOffset } satisfies NarrationAudioData
              : { texts: stage.texts, textInterval: stage.textInterval ?? 7 } satisfies NarrationTTSData,
          );
          stageOffset = ix.triggerAt;
        }

        if (ix.type === 'breath-sync') {
          cursor = this.addBreathingClips(cursor, stage, si, ix);
          stageOffset = ix.triggerAt; // breathing has own duration, narration resumes from triggerAt
        } else {
          const minDur = ix.data?.count ? (ix.data.count + 1) * 1.5 : INTERACTION_MIN_DURATION;
          const promptText = ix.data?.text ?? ix.data?.affirmation
            ?? (ix.type === 'focus-target' ? 'focus on the center' : 'do you want to go deeper?');
          cursor = this.addBlock(cursor, minDur, stage, si, 'interaction', {
            type: ix.type, promptText,
            blocking: ix.type === 'gate' || ix.type === 'voice-gate',
            minDuration: minDur,
          } satisfies InteractionClipData);
          stageOffset = ix.triggerAt + ix.duration; // gate consumes stage time
        }
      }

      // Remaining narration
      const remaining = stageDur - stageOffset;
      if (remaining > 0) {
        cursor = this.addBlock(cursor, remaining, stage, si,
          stageHasAudio ? 'narration-audio' : 'narration-tts',
          stageHasAudio
            ? { stageName: stage.name, audioOffset: stageOffset } satisfies NarrationAudioData
            : { texts: stage.texts, textInterval: stage.textInterval ?? 7 } satisfies NarrationTTSData,
        );
      }

      // Interlude — ambient-only silence after this stage
      const interlude = stage.interlude ?? 0;
      if (interlude > 0) {
        cursor = this.addBlock(cursor, interlude, stage, si, 'interlude',
          { duration: interlude } satisfies InterludeData,
        );
      }
    }

    this._totalDuration = cursor;
    log.info('timeline', `Built: ${this.blocks.length} clips, ${cursor.toFixed(1)}s`);
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      log.info('timeline', `  [${i}] ${b.clipType} ${b.stage.name} ${b.start.toFixed(1)}→${b.end.toFixed(1)}s (${b.duration.toFixed(1)}s)`);
    }
  }

  private addBlock(
    cursor: number, duration: number,
    stage: SessionStage, stageIndex: number,
    clipType: ClipType, data: unknown,
  ): number {
    this.blocks.push({
      clipType, start: cursor, duration, end: cursor + duration,
      stage, stageIndex, data,
    });
    return cursor + duration;
  }

  private addBreathingClips(cursor: number, stage: SessionStage, si: number, ix: Interaction): number {
    const pat = stage.breathPattern ?? { inhale: stage.breathCycle / 2, exhale: stage.breathCycle / 2 };
    const breaths = ix.data?.count ?? DEFAULT_BREATHS;
    const coreDur = cycleDuration(pat) * breaths;

    cursor = this.addBlock(cursor, BREATHING_INTRO_DURATION, stage, si, 'breathing-intro', {
      pattern: pat, introText: 'let\u2019s breathe together',
    } satisfies BreathIntroData);

    cursor = this.addBlock(cursor, coreDur, stage, si, 'breathing-core', {
      pattern: pat, breaths,
    } satisfies BreathCoreData);

    cursor = this.addBlock(cursor, BREATHING_OUTRO_DURATION, stage, si, 'breathing-outro', {
      pattern: pat, outroTexts: ['continue breathing', 'just like that'],
    } satisfies BreathOutroData);

    return cursor;
  }

  // ══════════════════════════════════════════════════════════════
  // PLAYBACK CONTROL
  // ══════════════════════════════════════════════════════════════

  start(): void {
    this._started = true;
    this._paused = false;
    this._completeFired = false;
    this._position = 0;
    this.currentBlockIndex = 0;
    this._prevBlockIndex = -1;
    this.wallStartTime = this.clock.now();
    this.totalPauseDuration = 0;
    this.audioElement = null;
    this.audioBlockStart = 0;
    log.info('timeline', 'Started');
  }

  pause(): void {
    if (this._paused) return;
    this._position = this.readClock();
    this._paused = true;
    this.pauseStartTime = this.clock.now();
  }

  resume(): void {
    if (!this._paused) return;
    this.totalPauseDuration += this.clock.now() - this.pauseStartTime;
    this._paused = false;
  }

  stop(): void {
    this._started = false;
    this._paused = false;
    this.audioElement = null;
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this._totalDuration));
    this._position = clamped;
    this._seeked = true;
    this.wallStartTime = this.clock.now() - clamped;
    this.totalPauseDuration = 0;
    this.audioElement = null;
    const newBlock = this.findBlock(clamped);
    if (newBlock !== this.currentBlockIndex) this._prevBlockIndex = -1;
    this.currentBlockIndex = newBlock;
    this._completeFired = false;
  }

  setSpeed(s: number): void {
    this._position = this.readClock();
    this.wallStartTime = this.clock.now() - this._position;
    this.totalPauseDuration = 0;
    this.speedMultiplier = s;
  }

  setInteractionMode(on: boolean): void { this._interactionMode = on; }

  // ══════════════════════════════════════════════════════════════
  // AUDIO BINDING
  // ══════════════════════════════════════════════════════════════

  bindAudio(audio: HTMLAudioElement, blockStart: number): void {
    this.audioElement = audio;
    this.audioBlockStart = blockStart;
  }

  unbindAudio(): void {
    if (!this.audioElement) return;
    this._position = this.audioBlockStart + this.audioElement.currentTime;
    this.audioElement = null;
    this.wallStartTime = this.clock.now() - this._position / this.speedMultiplier;
    this.totalPauseDuration = 0;
  }

  audioEnded(): void { this.unbindAudio(); }

  // ══════════════════════════════════════════════════════════════
  // UPDATE — call every frame
  // ══════════════════════════════════════════════════════════════

  update(): TimelineState | null {
    if (!this._started || this.blocks.length === 0) return null;

    const wasSeek = this._seeked;
    this._seeked = false;
    const pos = this._paused ? this._position : this.readClock();

    // Advance block
    const block = this.blocks[this.currentBlockIndex];
    if (!this._paused && pos >= block.end && this.currentBlockIndex < this.blocks.length - 1) {
      this.currentBlockIndex++;
    }
    const blockJustChanged = this.currentBlockIndex !== this._prevBlockIndex;
    this._prevBlockIndex = this.currentBlockIndex;

    // Completion
    const isLast = this.currentBlockIndex >= this.blocks.length - 1;
    if ((pos >= this._totalDuration || (isLast && pos >= this._totalDuration - 0.5)) && !this._completeFired) {
      this._completeFired = true;
    }

    // Derive clip frame — pure dispatch, no switch
    const curBlock = this.blocks[this.currentBlockIndex];
    const elapsed = Math.max(0, pos - curBlock.start);
    const deriver = clipDerivers[curBlock.clipType];
    const frame = deriver(elapsed, curBlock.data, this._interactionMode);

    return {
      ...frame,
      position: pos,
      block: curBlock,
      blockIndex: this.currentBlockIndex,
      blockElapsed: elapsed,
      blockProgress: curBlock.duration > 0 ? Math.min(1, elapsed / curBlock.duration) : 1,
      intensity: calcIntensity(this.blocks, this.currentBlockIndex, pos),
      spiralSpeed: curBlock.stage.spiralSpeed ?? 1,
      blockJustChanged,
      seeked: wasSeek,
      complete: this._completeFired,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // GETTERS
  // ══════════════════════════════════════════════════════════════

  get position(): number { return this._paused ? this._position : this.readClock(); }
  get started(): boolean { return this._started; }
  get paused(): boolean { return this._paused; }
  get totalDuration(): number { return this._totalDuration; }
  get currentBlock(): TimelineBlock { return this.blocks[this.currentBlockIndex]; }
  get currentIndex(): number { return this.currentBlockIndex; }
  get blockCount(): number { return this.blocks.length; }
  get allBlocks(): readonly TimelineBlock[] { return this.blocks; }
  get isAudioBound(): boolean { return this.audioElement !== null; }

  // ══════════════════════════════════════════════════════════════
  // INTERNAL
  // ══════════════════════════════════════════════════════════════

  private readClock(): number {
    if (this.audioElement) {
      return this.audioBlockStart + this.audioElement.currentTime;
    }
    const wallNow = this.clock.now();
    return (wallNow - this.wallStartTime - this.totalPauseDuration) * this.speedMultiplier;
  }

  private findBlock(t: number): number {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (t >= this.blocks[i].start) return i;
    }
    return 0;
  }

  reset(): void {
    this._started = false;
    this._paused = false;
    this._position = 0;
    this._completeFired = false;
    this.currentBlockIndex = 0;
    this._prevBlockIndex = -1;
    this.audioElement = null;
    this.blocks = [];
    this._totalDuration = 0;
  }
}
