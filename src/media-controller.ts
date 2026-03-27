/**
 * MediaController — single source of truth for playback state.
 *
 * Wraps Timeline + NarrationEngine + AudioCompositor into one coherent API.
 * All state transitions are atomic. No caller should touch Timeline.pause()
 * or NarrationEngine.stageAudioElement.play() directly — go through this.
 *
 * State machine: idle → loading → playing ⇄ paused → ended
 *                                    ↕
 *                                 seeking
 */

import type { Timeline, TimelineState } from './timeline';
import type { NarrationEngine } from './narration';
import type { AudioCompositor } from './audio-compositor';
import type { AudioEngine } from './audio';
import type { SettingsManager } from './settings';
import { log } from './logger';

export type MediaState = 'idle' | 'loading' | 'playing' | 'paused' | 'seeking' | 'ended';

export class MediaController {
  private timeline: Timeline;
  private narration: NarrationEngine;
  private audioCompositor: AudioCompositor;
  private audio: AudioEngine;
  private settings: SettingsManager;

  private _state: MediaState = 'idle';
  private seekEpoch = 0;
  private _tabSuspended = false;
  private _wasPlayingBeforeTab = false;
  private _boundAudio: HTMLAudioElement | null = null;
  private _visibilityHandler: (() => void) | null = null;
  private _completionFired = false;

  constructor(opts: {
    timeline: Timeline;
    narration: NarrationEngine;
    audioCompositor: AudioCompositor;
    audio: AudioEngine;
    settings: SettingsManager;
  }) {
    this.timeline = opts.timeline;
    this.narration = opts.narration;
    this.audioCompositor = opts.audioCompositor;
    this.audio = opts.audio;
    this.settings = opts.settings;

    // Wire audio-ready callback from narration
    // The narration doesn't know the blockStart — we derive it from the current block
    this.narration.setAudioReadyHandler((audioEl, _placeholder) => {
      const block = this.timeline.currentBlock;
      const blockStart = block?.start ?? 0;
      this.onAudioReady(audioEl, blockStart);
    });

    // Tab visibility handling
    this._visibilityHandler = () => this.handleVisibilityChange();
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  // ── State getters ──

  get state(): MediaState { return this._state; }
  get isPlaying(): boolean { return this._state === 'playing'; }
  get isPaused(): boolean { return this._state === 'paused'; }
  get isSeeking(): boolean { return this._state === 'seeking'; }
  get position(): number { return this.timeline.position; }
  get duration(): number { return this.timeline.totalDuration; }
  get tabSuspended(): boolean { return this._tabSuspended; }

  // ── State machine ──

  private setState(s: MediaState): void {
    if (this._state === s) return;
    log.info('media', `${this._state} → ${s}`);
    this._state = s;
  }

  private guard(...allowed: MediaState[]): boolean {
    if (allowed.includes(this._state)) return true;
    log.warn('media', `${this._state}: rejected (expected ${allowed.join('|')})`);
    return false;
  }

  // ── Playback control ──

  /**
   * Start playback. Call after timeline is built and ready.
   * Transitions: idle|paused → playing
   */
  play(): void {
    if (!this.guard('idle', 'paused', 'loading')) return;
    if (this._state === 'idle' || this._state === 'loading') {
      this.timeline.start();
    }
    this._completionFired = false;
    this.audioCompositor.setMasterVolume(this.getAmbientVolume());
    this.setState('playing');
  }

  /**
   * Pause everything atomically.
   * Order: timeline.pause() FIRST (captures position from live audio),
   * THEN pause audio element, THEN mute ambient.
   */
  async pause(): Promise<void> {
    if (!this.guard('playing')) return;
    this.setState('paused');

    // 1. Timeline captures position from still-playing audio
    this.timeline.pause();

    // 2. Now pause the audio element (position already captured)
    if (this.narration.stageAudioElement && !this.narration.stageAudioElement.paused) {
      this.narration.stageAudioElement.pause();
    }

    // 3. Mute ambient
    this.audioCompositor.setMasterVolume(0);
  }

  /**
   * Resume everything atomically.
   * Order: resume AudioContext, AWAIT audio.play(), THEN timeline.resume().
   * This ensures readClock() reads from live audio on the first frame.
   */
  async resume(): Promise<void> {
    if (!this.guard('paused')) return;

    // 1. Ensure AudioContext is running (mobile might have suspended it)
    try {
      await this.audio.context?.resume();
    } catch { /* ok */ }

    // 2. Resume narration audio element FIRST — must await so it's actually playing
    let audioResumed = false;
    const audioEl = this.narration.stageAudioElement;
    if (audioEl?.paused) {
      try {
        await audioEl.play();
        audioResumed = true;
        log.info('media', `Narration audio resumed at ${audioEl.currentTime.toFixed(1)}s`);
      } catch {
        log.warn('media', 'Audio play() rejected on resume — will re-enter stage');
      }
    } else if (audioEl && !audioEl.paused) {
      // Already playing (shouldn't happen, but handle it)
      audioResumed = true;
    }

    // 3. NOW resume timeline — readClock() will use the live audio element
    this.timeline.resume();

    // 4. Re-bind audio to timeline (ensures sync after pause gap)
    if (audioResumed && audioEl && this._boundAudio === audioEl) {
      const block = this.timeline.currentBlock;
      if (block) {
        this.timeline.bindAudio(audioEl, block.start);
      }
    }

    // 5. If narration audio couldn't resume, re-enter the stage at current position
    if (!audioResumed && this.narration.isPlayingStage) {
      const block = this.timeline.currentBlock;
      if (block) {
        const offset = this.timeline.position - block.start;
        const stageName = (block.data as { stageName?: string })?.stageName;
        if (stageName) {
          log.info('media', `Re-entering stage ${stageName} at offset ${offset.toFixed(1)}s`);
          this.narration.enterStage(stageName, Math.max(0, offset));
        }
      }
    }

    // 6. Restore ambient volume
    this.audioCompositor.setMasterVolume(this.getAmbientVolume());

    this.setState('playing');
  }

  /** Toggle between playing and paused */
  async togglePause(): Promise<void> {
    if (this._state === 'playing') {
      await this.pause();
    } else if (this._state === 'paused') {
      await this.resume();
    }
  }

  /**
   * Seek to absolute time. Handles audio element lifecycle atomically.
   * Rapid seeks are cancelled via epoch counter.
   */
  async seek(t: number): Promise<void> {
    if (!this.guard('playing', 'paused', 'seeking')) return;
    const wasPaused = this._state === 'paused';
    const epoch = ++this.seekEpoch;

    this.setState('seeking');

    // 1. Stop old narration audio cleanly
    this.narration.stopStagePlayback();
    this._boundAudio = null;

    // 2. Seek timeline (clears audio binding, resets wall clock)
    this.timeline.seek(t);

    // 3. Determine what the new block wants
    const tlState = this.timeline.update();
    if (!tlState || epoch !== this.seekEpoch) return; // cancelled

    // 4. If new block has narration audio, start it at the right offset
    if (tlState.wantsNarrationAudio && tlState.narrationStageName) {
      const offset = tlState.narrationAudioOffset + tlState.blockElapsed;
      this.narration.enterStage(tlState.narrationStageName, offset);
      // Audio binding happens via onAudioReady callback — no polling needed
    }

    if (epoch !== this.seekEpoch) return; // cancelled by a newer seek

    // 5. Restore state
    if (wasPaused) {
      this.timeline.pause();
      if (this.narration.stageAudioElement && !this.narration.stageAudioElement.paused) {
        this.narration.stageAudioElement.pause();
      }
      this.setState('paused');
    } else {
      this.setState('playing');
    }
  }

  /** Stop everything and return to idle */
  stop(): void {
    this.narration.stopStagePlayback();
    this.narration.stop();
    this.timeline.stop();
    this._boundAudio = null;
    this._completionFired = false;
    this.setState('idle');
  }

  // ── Per-frame tick (called by session) ──

  /**
   * Advance the timeline and return state.
   * Returns null if not in a playable state.
   * Handles completion detection.
   */
  tick(): TimelineState | null {
    if (this._state !== 'playing' && this._state !== 'paused') return null;
    if (this._tabSuspended) return null;

    const tlState = this.timeline.update();
    if (!tlState) return null;

    // Handle narration directives for block changes (only when playing)
    if (this._state === 'playing' && (tlState.blockJustChanged || tlState.seeked)) {
      this.handleBlockTransition(tlState);
    }

    // Completion
    if (tlState.complete && !this._completionFired) {
      this._completionFired = true;
    }

    return tlState;
  }

  get completionFired(): boolean { return this._completionFired; }

  // ── Block transition handling (centralized) ──

  private handleBlockTransition(tlState: TimelineState): void {
    if (tlState.wantsNarrationAudio && tlState.narrationStageName) {
      const offset = tlState.narrationAudioOffset + tlState.blockElapsed;

      // Only restart if it's actually a new stage (dedup)
      const currentStage = this.narration.stageName;
      if (currentStage !== tlState.narrationStageName) {
        this.narration.enterStage(tlState.narrationStageName, offset);
      }
    } else if (tlState.blockJustChanged) {
      this.narration.stopStagePlayback();
    }
  }

  // ── Audio binding (callback-based, not polling) ──

  /**
   * Called by NarrationEngine when audio.play() resolves successfully.
   * Binds the audio element as the timeline's clock source immediately.
   */
  onAudioReady(audioEl: HTMLAudioElement, blockStart: number): void {
    if (this._state === 'idle' || this._state === 'ended') return;
    this._boundAudio = audioEl;
    this.timeline.bindAudio(audioEl, blockStart);
    log.info('media', `Audio bound: ${audioEl.src.split('/').pop()} at ${blockStart.toFixed(1)}s`);

    // Listen for natural end
    audioEl.addEventListener('ended', () => this.onAudioEnded(), { once: true });
  }

  /** Called when narration audio ends naturally */
  onAudioEnded(): void {
    this.timeline.audioEnded();
    this._boundAudio = null;
  }

  // ── Tab visibility ──

  private handleVisibilityChange(): void {
    if (document.hidden) {
      // Tab going hidden
      if (this._state === 'playing') {
        this._tabSuspended = true;
        this._wasPlayingBeforeTab = true;
        log.info('media', 'Tab hidden — suspended');
      }
    } else {
      // Tab returning
      if (this._tabSuspended) {
        this._tabSuspended = false;
        log.info('media', 'Tab visible — reconciling');
        this.reconcileAfterTab();
      }
    }
  }

  private async reconcileAfterTab(): Promise<void> {
    // Resume AudioContext if suspended
    try {
      await this.audio.context?.resume();
    } catch { /* ok */ }

    if (this._boundAudio && this.narration.stageAudioElement) {
      // Audio element is the authority — its currentTime may have frozen
      const audioTime = this.narration.stageAudioElement.currentTime;
      const block = this.timeline.currentBlock;
      if (block) {
        // Re-anchor timeline to audio position
        const truePosition = block.start + audioTime;
        // Don't use seek() (too heavy) — just reset the wall clock
        this.timeline.seek(truePosition);
        this.timeline.bindAudio(this.narration.stageAudioElement, block.start);
      }

      // Resume audio if browser suspended it
      if (this.narration.stageAudioElement.paused && this._wasPlayingBeforeTab) {
        try {
          await this.narration.stageAudioElement.play();
        } catch { /* ok */ }
      }
    }

    this._wasPlayingBeforeTab = false;
  }

  // ── Helpers ──

  private getAmbientVolume(): number {
    return (this.settings.current as unknown as Record<string, number>).ambientVolume ?? 0.7;
  }

  dispose(): void {
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this.narration.setAudioReadyHandler(null);
    this.stop();
  }
}
