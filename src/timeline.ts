/**
 * Timeline — block-based, single source of truth for session progression.
 *
 * The timeline is a flat array of typed blocks (narration, breathing, interaction,
 * transition). Everything derives from position alone — breathing phase, text,
 * intensity, interaction state. If a frame errors, the next frame re-derives
 * the correct state from the clock and self-heals.
 *
 * Position sources (in priority order):
 *   1. Bound audio element's currentTime + block offset (pre-recorded sessions)
 *   2. Wall clock with pause compensation (TTS / no-audio sessions)
 */

import { log } from './logger';
import type {
  SessionStage, Interaction, BreathPatternConfig,
  TimelineBlock, NarrationBlockData, BreathingBlockData, InteractionBlockData,
} from './session';
import type { BreathStage } from './breath';

// Re-export block type for consumers
export type { TimelineBlock } from './session';

// ── Derived state — returned every frame ─────────────────────────

export interface TimelineState {
  position: number;
  block: TimelineBlock;
  blockIndex: number;
  blockElapsed: number;
  blockProgress: number;        // 0-1

  // From block type + elapsed
  currentText: string | null;
  breathValue: number | null;   // 0-1 cosine-eased (breathing blocks only)
  breathStage: BreathStage | null;
  breathPattern: BreathPatternConfig | null;

  // From parent stage
  intensity: number;
  spiralSpeed: number;

  // Edge flags
  blockJustChanged: boolean;
  seeked: boolean;
  complete: boolean;

  // Interaction state
  atBoundary: boolean;          // paused at blocking interaction end
}

// ── Intensity helpers ────────────────────────────────────────────

const FRAC_HOLD = 4;
const FRAC_RAMP = 3;

/** Calculate intensity from the block's parent stage, with fractionation + blending */
function calcIntensity(
  blocks: TimelineBlock[],
  blockIdx: number,
  pos: number,
  totalDuration: number,
): number {
  const block = blocks[blockIdx];
  const base = block.stage.intensity;

  // Fractionation dip: only at the start of a stage (first block for this stageIndex)
  let intensity = base;
  const dip = block.stage.fractionationDip;
  if (dip != null) {
    // Find the first block for this stage
    let stageStart = block.start;
    for (let i = blockIdx - 1; i >= 0; i--) {
      if (blocks[i].stageIndex === block.stageIndex) stageStart = blocks[i].start;
      else break;
    }
    const stageElapsed = pos - stageStart;
    if (stageElapsed < FRAC_HOLD + FRAC_RAMP) {
      if (stageElapsed < FRAC_HOLD) {
        intensity = dip;
      } else {
        const rampT = (stageElapsed - FRAC_HOLD) / FRAC_RAMP;
        intensity = dip + (base - dip) * Math.min(1, rampT);
      }
    }
  }

  // Blend toward next stage in last 15% of the final block of this stage
  // Find the last block for this stage
  let lastBlockForStage = blockIdx;
  for (let i = blockIdx + 1; i < blocks.length; i++) {
    if (blocks[i].stageIndex === block.stageIndex) lastBlockForStage = i;
    else break;
  }
  if (blockIdx === lastBlockForStage) {
    const stageEnd = blocks[lastBlockForStage].end;
    let stageStart = block.start;
    for (let i = blockIdx - 1; i >= 0; i--) {
      if (blocks[i].stageIndex === block.stageIndex) stageStart = blocks[i].start;
      else break;
    }
    const stageDuration = stageEnd - stageStart;
    const stageProgress = stageDuration > 0 ? (pos - stageStart) / stageDuration : 1;
    if (stageProgress > 0.85 && lastBlockForStage < blocks.length - 1) {
      const blendT = (stageProgress - 0.85) / 0.15;
      const nextStageBlock = blocks[lastBlockForStage + 1];
      intensity += (nextStageBlock.stage.intensity - intensity) * blendT;
    }
  }

  return intensity;
}

// ── Breathing math (pure functions) ──────────────────────────────

function cycleDuration(pat: BreathPatternConfig): number {
  return pat.inhale + (pat.holdIn ?? 0) + pat.exhale + (pat.holdOut ?? 0);
}

function deriveBreath(
  elapsed: number,
  pat: BreathPatternConfig,
): { value: number; stage: BreathStage } {
  const cycle = cycleDuration(pat);
  const t = ((elapsed % cycle) + cycle) % cycle; // handle negative from seeks

  if (t < pat.inhale) {
    const p = t / pat.inhale;
    return { value: (1 - Math.cos(p * Math.PI)) / 2, stage: 'inhale' };
  }
  const afterInhale = pat.inhale;
  const holdIn = pat.holdIn ?? 0;
  if (t < afterInhale + holdIn) {
    return { value: 1, stage: 'hold-in' };
  }
  const afterHoldIn = afterInhale + holdIn;
  if (t < afterHoldIn + pat.exhale) {
    const p = (t - afterHoldIn) / pat.exhale;
    return { value: (1 + Math.cos(p * Math.PI)) / 2, stage: 'exhale' };
  }
  return { value: 0, stage: 'hold-out' };
}

/** Map breathStage to cue text */
function breathCueText(stage: BreathStage): string {
  switch (stage) {
    case 'inhale': return 'in';
    case 'hold-in': return 'hold';
    case 'exhale': return 'out';
    case 'hold-out': return 'hold';
  }
}

// ── Block builder constants ──────────────────────────────────────

const BREATHING_INTRO_DURATION = 3;   // seconds
const BREATHING_OUTRO_DURATION = 5;   // seconds
const DEFAULT_BREATHS = 4;
const INTERACTION_MIN_DURATION = 5;   // seconds to show prompt text
const TRANSITION_DURATION = 1;        // brief pause between stages

// ── Timeline ─────────────────────────────────────────────────────

export class Timeline {
  private blocks: TimelineBlock[] = [];
  private _totalDuration = 0;

  // Clock state
  private _position = 0;
  private _started = false;
  private _paused = false;
  private wallStartTime = 0;
  private pauseStartTime = 0;
  private totalPauseDuration = 0;
  private speedMultiplier = 1;

  // Pull-model: per-frame edge detection
  private _prevBlockIndex = -1;
  private _seeked = false;

  // Cached last state for external consumers (API)
  private _lastState: TimelineState | null = null;

  // Audio binding
  private audioElement: HTMLAudioElement | null = null;
  private audioBlockStart = 0;

  // Block tracking
  private currentBlockIndex = 0;
  private _completeFired = false;

  // Interaction mode — controls whether interaction blocks are blocking
  private _interactionMode = true;

  // ══════════════════════════════════════════════════════════════
  // BUILD — transform session stages into flat block array
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
      const stageAudioDur = audioDuration(stage.name);
      const stageDur = stageAudioDur ?? stage.duration;

      // Sort interactions by triggerAt
      const interactions = [...(stage.interactions ?? [])].sort((a, b) => a.triggerAt - b.triggerAt);

      // Split stage into blocks around interactions
      let stageOffset = 0;

      for (const ix of interactions) {
        // Narration block before this interaction
        if (ix.triggerAt > stageOffset) {
          const dur = ix.triggerAt - stageOffset;
          cursor = this.addNarrationBlock(cursor, dur, stage, si, stageHasAudio, stageOffset);
          stageOffset = ix.triggerAt;
        }

        // Interaction → block(s)
        if (ix.type === 'breath-sync') {
          // Breath-sync replaces narration with its own content (breathing blocks).
          // The full stage audio plays AFTER breathing, so stageOffset stays at triggerAt.
          cursor = this.addBreathingBlocks(cursor, stage, si, ix);
          stageOffset = ix.triggerAt;
        } else {
          // Gates/focus/etc interrupt the narration flow at triggerAt.
          // Audio already played up to this point, so advance past the interaction.
          cursor = this.addInteractionBlock(cursor, stage, si, ix);
          stageOffset = ix.triggerAt + ix.duration;
        }
      }

      // Remaining narration after last interaction
      const remaining = stageDur - stageOffset;
      if (remaining > 0) {
        cursor = this.addNarrationBlock(cursor, remaining, stage, si, stageHasAudio, stageOffset);
      }
    }

    this._totalDuration = cursor;

    const kinds = { narration: 0, breathing: 0, interaction: 0, transition: 0 };
    for (const b of this.blocks) kinds[b.kind]++;
    log.info('timeline', `Built: ${this.blocks.length} blocks (${kinds.narration}N ${kinds.breathing}B ${kinds.interaction}I), ${cursor.toFixed(1)}s`);

    // Debug: log each block for verification
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const extra = b.kind === 'breathing' ? ` (${b.breathing?.phase})`
        : b.kind === 'interaction' ? ` (${b.interaction?.type})`
        : b.narration?.hasAudio ? ' (audio)' : '';
      log.info('timeline', `  [${i}] ${b.kind}${extra} ${b.stage.name} ${b.start.toFixed(1)}s → ${b.end.toFixed(1)}s (${b.duration.toFixed(1)}s)`);
    }
  }

  private addNarrationBlock(
    cursor: number, duration: number,
    stage: SessionStage, stageIndex: number,
    hasAudio: boolean, stageOffset: number,
  ): number {
    const block: TimelineBlock = {
      kind: 'narration',
      start: cursor, duration, end: cursor + duration,
      stage, stageIndex,
      narration: {
        texts: stage.texts,
        textInterval: stage.textInterval ?? 7,
        hasAudio,
        audioOffset: stageOffset, // where in the stage audio this block starts
      },
    };
    this.blocks.push(block);
    return cursor + duration;
  }

  private addBreathingBlocks(
    cursor: number,
    stage: SessionStage, stageIndex: number,
    ix: Interaction,
  ): number {
    const pat = stage.breathPattern ?? { inhale: stage.breathCycle / 2, exhale: stage.breathCycle / 2 };
    const cycle = cycleDuration(pat);
    const breaths = ix.data?.count ?? DEFAULT_BREATHS;

    // Intro block
    const introBlock: TimelineBlock = {
      kind: 'breathing',
      start: cursor, duration: BREATHING_INTRO_DURATION, end: cursor + BREATHING_INTRO_DURATION,
      stage, stageIndex,
      breathing: {
        phase: 'intro',
        pattern: pat,
        introText: 'let\u2019s breathe together',
      },
    };
    this.blocks.push(introBlock);
    cursor += BREATHING_INTRO_DURATION;

    // Core block — N full breath cycles
    const coreDur = cycle * breaths;
    const coreBlock: TimelineBlock = {
      kind: 'breathing',
      start: cursor, duration: coreDur, end: cursor + coreDur,
      stage, stageIndex,
      breathing: {
        phase: 'core',
        pattern: pat,
        breaths,
      },
    };
    this.blocks.push(coreBlock);
    cursor += coreDur;

    // Outro block
    const outroBlock: TimelineBlock = {
      kind: 'breathing',
      start: cursor, duration: BREATHING_OUTRO_DURATION, end: cursor + BREATHING_OUTRO_DURATION,
      stage, stageIndex,
      breathing: {
        phase: 'outro',
        pattern: pat,
        outroTexts: ['continue breathing', 'just like that'],
      },
    };
    this.blocks.push(outroBlock);
    cursor += BREATHING_OUTRO_DURATION;

    return cursor;
  }

  private addInteractionBlock(
    cursor: number,
    stage: SessionStage, stageIndex: number,
    ix: Interaction,
  ): number {
    const minDur = ix.data?.count
      ? (ix.data.count + 1) * 1.5  // countdown
      : INTERACTION_MIN_DURATION;

    const promptText = ix.data?.text
      ?? ix.data?.affirmation
      ?? (ix.type === 'focus-target' ? 'focus on the center' : 'do you want to go deeper?');

    const block: TimelineBlock = {
      kind: 'interaction',
      start: cursor, duration: minDur, end: cursor + minDur,
      stage, stageIndex,
      interaction: {
        type: ix.type,
        promptText,
        blocking: ix.type === 'gate' || ix.type === 'voice-gate',
        minDuration: minDur,
        data: ix.data,
      },
    };
    this.blocks.push(block);
    return cursor + minDur;
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
    this.wallStartTime = performance.now() / 1000;
    this.totalPauseDuration = 0;
    this.audioElement = null;
    this.audioBlockStart = 0;
    log.info('timeline', 'Started');
  }

  pause(): void {
    if (this._paused) return;
    this._position = this.readClock();
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

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this._totalDuration));
    this._position = clamped;
    this._seeked = true;

    // Reset wall clock baseline
    this.wallStartTime = performance.now() / 1000 - clamped;
    this.totalPauseDuration = 0;

    // Unbind stale audio — will be re-bound after enterStage starts new audio
    this.audioElement = null;

    // Find block — only force blockJustChanged if the block actually changed.
    // Same-block seeks just set the seeked flag (avoids flicker during scrubbing).
    const newBlock = this.findBlock(clamped);
    if (newBlock !== this.currentBlockIndex) {
      this._prevBlockIndex = -1; // force blockJustChanged on next update()
    }
    this.currentBlockIndex = newBlock;
    this._completeFired = false;

    log.info('timeline', `Seeked to ${clamped.toFixed(1)}s → block ${this.currentBlockIndex} (${this.blocks[this.currentBlockIndex]?.kind})`);
  }

  setSpeed(s: number): void {
    this._position = this.readClock();
    this.wallStartTime = performance.now() / 1000 - this._position;
    this.totalPauseDuration = 0;
    this.speedMultiplier = s;
  }

  setInteractionMode(on: boolean): void {
    this._interactionMode = on;
  }

  // ══════════════════════════════════════════════════════════════
  // AUDIO BINDING
  // ══════════════════════════════════════════════════════════════

  bindAudio(audio: HTMLAudioElement, blockStart: number): void {
    this.audioElement = audio;
    this.audioBlockStart = blockStart;
    log.info('timeline', `Audio bound at block start ${blockStart.toFixed(1)}s`);
  }

  unbindAudio(): void {
    if (!this.audioElement) return;
    this._position = this.readClock();
    this.audioElement = null;
    this.wallStartTime = performance.now() / 1000 - this._position;
    this.totalPauseDuration = 0;
    log.info('timeline', `Audio unbound at ${this._position.toFixed(1)}s`);
  }

  audioEnded(): void {
    this.unbindAudio();
  }

  // ══════════════════════════════════════════════════════════════
  // UPDATE — call every frame
  // ══════════════════════════════════════════════════════════════

  update(): TimelineState | null {
    if (!this._started || this.blocks.length === 0) return null;

    const wasSeek = this._seeked;
    this._seeked = false;

    const pos = this._paused ? this._position : this.readClock();

    // Advance block if needed
    const block = this.blocks[this.currentBlockIndex];
    if (!this._paused && pos >= block.end && this.currentBlockIndex < this.blocks.length - 1) {
      this.currentBlockIndex++;
    }

    const blockJustChanged = this.currentBlockIndex !== this._prevBlockIndex;
    this._prevBlockIndex = this.currentBlockIndex;

    // Completion
    if (pos >= this._totalDuration && !this._completeFired) {
      this._completeFired = true;
    }

    const state = this.deriveState(pos, blockJustChanged, wasSeek);
    this._lastState = state;
    return state;
  }

  // ══════════════════════════════════════════════════════════════
  // STATE DERIVATION — pure function from position
  // ══════════════════════════════════════════════════════════════

  private deriveState(pos: number, blockJustChanged: boolean, seeked: boolean): TimelineState {
    const block = this.blocks[this.currentBlockIndex];
    const elapsed = Math.max(0, pos - block.start);
    const progress = block.duration > 0 ? Math.min(1, elapsed / block.duration) : 1;

    // Derive block-type-specific fields
    let currentText: string | null = null;
    let breathValue: number | null = null;
    let breathStage: BreathStage | null = null;
    let atBoundary = false;

    switch (block.kind) {
      case 'narration': {
        const data = block.narration!;
        if (!data.hasAudio && data.texts.length > 0 && data.textInterval > 0) {
          // Derive current text from elapsed position
          const textIdx = Math.floor(elapsed / data.textInterval);
          if (textIdx < data.texts.length) {
            currentText = data.texts[textIdx % data.texts.length];
          }
        }
        break;
      }

      case 'breathing': {
        const data = block.breathing!;
        switch (data.phase) {
          case 'intro':
            currentText = data.introText ?? null;
            // Start at breathValue 0 during intro
            breathValue = 0;
            breathStage = 'inhale';
            break;
          case 'core': {
            const breath = deriveBreath(elapsed, data.pattern);
            breathValue = breath.value;
            breathStage = breath.stage;
            currentText = breathCueText(breath.stage);
            break;
          }
          case 'outro': {
            // Show outro texts in sequence
            if (data.outroTexts && data.outroTexts.length > 0) {
              const textDur = block.duration / data.outroTexts.length;
              const idx = Math.min(Math.floor(elapsed / textDur), data.outroTexts.length - 1);
              currentText = data.outroTexts[idx];
            }
            breathValue = 0;
            breathStage = 'exhale';
            break;
          }
        }
        break;
      }

      case 'interaction': {
        const data = block.interaction!;
        currentText = data.promptText;
        // Auto-pause at boundary when interaction mode is on and block is blocking
        if (data.blocking && this._interactionMode && elapsed >= data.minDuration) {
          atBoundary = true;
        }
        break;
      }

      case 'transition':
        // Silent gap — nothing to derive
        break;
    }

    return {
      position: pos,
      block,
      blockIndex: this.currentBlockIndex,
      blockElapsed: elapsed,
      blockProgress: progress,
      currentText,
      breathValue,
      breathStage,
      breathPattern: block.stage.breathPattern ?? null,
      intensity: calcIntensity(this.blocks, this.currentBlockIndex, pos, this._totalDuration),
      spiralSpeed: block.stage.spiralSpeed ?? 1,
      blockJustChanged,
      seeked,
      complete: pos >= this._totalDuration,
      atBoundary,
    };
  }

  // ══════════════════════════════════════════════════════════════
  // GETTERS
  // ══════════════════════════════════════════════════════════════

  get position(): number {
    if (this._paused) return this._position;
    return this.readClock();
  }

  get started(): boolean { return this._started; }
  get paused(): boolean { return this._paused; }
  get totalDuration(): number { return this._totalDuration; }
  get currentBlock(): TimelineBlock { return this.blocks[this.currentBlockIndex]; }
  get currentIndex(): number { return this.currentBlockIndex; }
  get blockCount(): number { return this.blocks.length; }
  get allBlocks(): readonly TimelineBlock[] { return this.blocks; }
  get isAudioBound(): boolean { return this.audioElement !== null; }
  get speed(): number { return this.speedMultiplier; }
  get lastState(): TimelineState | null { return this._lastState; }

  // ══════════════════════════════════════════════════════════════
  // INTERNAL
  // ══════════════════════════════════════════════════════════════

  private readClock(): number {
    if (this.audioElement && !this.audioElement.paused) {
      return this.audioBlockStart + this.audioElement.currentTime;
    }
    const wallNow = performance.now() / 1000;
    const rawElapsed = wallNow - this.wallStartTime - this.totalPauseDuration;
    return rawElapsed * this.speedMultiplier;
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
    this._lastState = null;
  }
}
