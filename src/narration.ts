/**
 * NarrationEngine — manages script playback with text display and TTS voicing.
 *
 * Two layers:
 *   1. Text display: word-by-word reveal synced to speech timing
 *   2. Voice: Web Speech API (free, built-in) with hooks for future premium TTS
 *
 * The engine queues narration lines and plays them with configurable pauses.
 * It exposes speaking state so visuals can react to the narrator's voice.
 */

import { log } from './logger';

export interface NarrationLine {
  /** The text to display and optionally speak */
  text: string;
  /** Pause after this line in seconds (default: 2) */
  pause?: number;
  /** Speech style hint — affects rate and pitch */
  emphasis?: 'soft' | 'normal' | 'deep';
}

export interface NarrationState {
  /** Currently speaking/displaying */
  isSpeaking: boolean;
  /** Current line text being displayed */
  currentText: string;
  /** 0-1 progress through the current line */
  lineProgress: number;
  /** 0-1 simulated voice energy while speaking (for audio-reactive visuals) */
  voiceEnergy: number;
  /** Whether narration is active at all */
  active: boolean;
}

export interface NarrationConfig {
  /** Enable TTS voicing (default: true) */
  voiceEnabled: boolean;
  /** Speech rate 0.1-2.0 (default: 0.85 — slightly slow for hypnosis) */
  rate: number;
  /** Speech pitch 0-2 (default: 0.9 — slightly low) */
  pitch: number;
  /** Speech volume 0-1 (default: 0.8) */
  volume: number;
  /** Preferred voice name substring to match (e.g. "Google UK English Female") */
  preferredVoice?: string;
}

const DEFAULT_CONFIG: NarrationConfig = {
  voiceEnabled: true,
  rate: 0.85,
  pitch: 0.9,
  volume: 0.8,
};

/** Pre-generated audio manifest (from SexyVoice.ai or similar) */
export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface AudioManifest {
  session: string;
  stages: Array<{
    name: string;
    file?: string;       // full stage audio (continuous, no cuts)
    duration?: number;
    lines: Array<{
      file?: string;     // per-line audio (legacy sliced mode)
      text: string;
      startTime?: number; // offset in stage audio where this line starts
      endTime?: number;   // offset where it ends
      duration: number;
      words?: WordTimestamp[];
    }>;
  }>;
}

import type { EventBus } from './events';

export class NarrationEngine {
  private config: NarrationConfig;
  private queue: NarrationLine[] = [];
  private currentLine: NarrationLine | null = null;
  private _isSpeaking = false;
  private _voiceEnergy = 0;
  private _lineProgress = 0;
  private _active = false;
  private speechStartTime = 0;
  private estimatedDuration = 0;
  private selectedVoice: SpeechSynthesisVoice | null = null;
  private voicesLoaded = false;
  // Pull-model: current display line (replaces onTextDisplay callback)
  private _displayLine: { text: string; words?: WordTimestamp[]; startTime: number } | null = null;
  private paused = false;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private processingQueue = false;
  private warmedUp = false;

  // Pre-generated audio playback
  private manifest: AudioManifest | null = null;
  private _manifestPromise: Promise<void> | null = null;
  private audioLookup: Map<string, { file: string; duration: number; words?: WordTimestamp[] }> = new Map();
  private interactiveLookup: Map<string, { file: string; duration: number }> = new Map();
  private currentAudio: HTMLAudioElement | null = null;

  // Continuous stage playback (no slicing)
  private stageAudio: HTMLAudioElement | null = null;
  private stageMediaSource: MediaElementAudioSourceNode | null = null;
  private stageLines: Array<{ text: string; startTime: number; endTime: number; words?: WordTimestamp[] }> = [];
  private stageCurrentLine = -1;
  private stagePlaybackActive = false;
  private onStageEnded: (() => void) | null = null;
  private stageTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Spatial audio routing
  private _audioCtx: AudioContext | null = null;
  private _panner: PannerNode | null = null;
  private _outputNode: GainNode | null = null;

  constructor(config?: Partial<NarrationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loadVoices();
  }

  /**
   * Enable spatial audio — routes narration through a 3D panner.
   * Call once after AudioContext is available.
   */
  enableSpatialAudio(ctx: AudioContext, output: GainNode): void {
    this._audioCtx = ctx;
    this._outputNode = output;

    this._panner = ctx.createPanner();
    this._panner.panningModel = 'HRTF';
    this._panner.distanceModel = 'inverse';
    this._panner.refDistance = 1;
    this._panner.maxDistance = 10;
    this._panner.rolloffFactor = 1.5;
    this._panner.positionX.value = 0;
    this._panner.positionY.value = 0.2;
    this._panner.positionZ.value = -1.3;
    this._panner.connect(output);

    log.info('narration', 'Spatial audio enabled (HRTF panner)');
  }

  /** Update the 3D position of the narration voice (follow the wisp) */
  setSpatialPosition(x: number, y: number, z: number): void {
    if (!this._panner) return;
    this._panner.positionX.linearRampToValueAtTime(x, (this._audioCtx?.currentTime ?? 0) + 0.1);
    this._panner.positionY.linearRampToValueAtTime(y + 0.1, (this._audioCtx?.currentTime ?? 0) + 0.1);
    this._panner.positionZ.linearRampToValueAtTime(z, (this._audioCtx?.currentTime ?? 0) + 0.1);
  }

  /** Current display line (pull-model — read by animate loop each frame) */
  get displayLine(): Readonly<{ text: string; words?: WordTimestamp[]; startTime: number }> | null {
    return this._displayLine;
  }

  /**
   * Load a pre-generated audio manifest. When loaded, speak() will play
   * audio files instead of browser TTS for any text that matches.
   */
  /** Wait for any in-flight manifest load to complete (resolves immediately if none). */
  waitForManifest(): Promise<void> {
    return this._manifestPromise ?? Promise.resolve();
  }

  async loadManifest(url: string): Promise<void> {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.manifest = await resp.json();

      // Build lookups
      this.audioLookup.clear();
      this.interactiveLookup.clear();
      if (this.manifest) {
        for (const stage of this.manifest.stages) {
          for (const line of stage.lines) {
            if (line.file) {
              const key = line.text.trim().toLowerCase();
              this.audioLookup.set(key, { file: line.file, duration: line.duration, words: line.words });
            }
          }
        }
        // Interactive lines (keyed by id)
        const interactive = (this.manifest as unknown as Record<string, unknown>).interactive as
          Array<{ id: string; file: string; duration: number }> | undefined;
        if (interactive) {
          for (const item of interactive) {
            this.interactiveLookup.set(item.id, { file: item.file, duration: item.duration });
          }
        }
      }
      log.info('narration', `Loaded audio manifest: ${this.audioLookup.size} lines, ${this.interactiveLookup.size} interactive`);
    } catch (e) {
      log.warn('narration', 'Failed to load audio manifest', e);
      this.manifest = null;
    }
  }

  /** Clear loaded manifest (revert to browser TTS) */
  clearManifest(): void {
    this.manifest = null;
    this.audioLookup.clear();
    this.interactiveLookup.clear();
    this.stopStagePlayback();
  }

  /**
   * Play a full stage as one continuous audio file.
   * Text display updates are driven by timestamps — no slicing.
   * Returns a promise that resolves when the stage audio finishes.
   */
  async playStage(stageName: string, offset = 0): Promise<void> {
    if (!this.manifest) return;

    const stage = this.manifest.stages.find(s => s.name === stageName);
    if (!stage?.file) return;

    this.stopStagePlayback();

    // Build line timing data
    this.stageLines = stage.lines.map(l => ({
      text: l.text,
      startTime: l.startTime ?? 0,
      endTime: l.endTime ?? l.duration,
      words: l.words,
    }));
    this.stageCurrentLine = -1;
    this.stagePlaybackActive = true;

    // Play the full stage audio
    const audio = new Audio(stage.file);
    audio.crossOrigin = 'anonymous';
    this.stageAudio = audio;
    this.stageMediaSource = null;

    // Route through Web Audio spatial panner if available.
    // We connect AFTER the element is ready to avoid sample rate issues.
    if (this._audioCtx && this._panner) {
      audio.volume = 1; // volume via gain nodes
      const connectSpatial = () => {
        if (!this._audioCtx || !this._panner || this.stageAudio !== audio) return;
        try {
          // createMediaElementSource can only be called once per element
          const source = this._audioCtx.createMediaElementSource(audio);
          const volumeGain = this._audioCtx.createGain();
          volumeGain.gain.value = this.config.volume;
          source.connect(volumeGain);
          volumeGain.connect(this._panner);
          this.stageMediaSource = source;
          log.info('narration', 'Spatial audio connected');
        } catch (e) {
          log.warn('narration', 'Spatial routing failed', e);
        }
      };
      // Connect immediately — the element handles buffering internally
      connectSpatial();
    } else {
      audio.volume = this.config.volume;
    }
    this._isSpeaking = true;
    this._active = true;
    this.speechStartTime = performance.now() / 1000;
    this.estimatedDuration = stage.duration ?? 0;

    log.info('narration', `playStage: ${stageName} (${(stage.duration ?? 0).toFixed(1)}s)`, { file: stage.file });

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = (reason: string) => {
        if (resolved) return;
        resolved = true;
        if (this.stageTimeoutId) {
          clearTimeout(this.stageTimeoutId);
          this.stageTimeoutId = null;
        }
        log.info('narration', `playStage done: ${stageName} (${reason})`);
        this.stagePlaybackActive = false;
        this._isSpeaking = false;
        this.stageAudio = null;
        if (this.onStageEnded) this.onStageEnded();
        resolve();
      };

      audio.onended = () => done('ended');
      audio.onerror = () => {
        log.warn('narration', `Stage audio failed to load: ${stageName}`);
        done('error');
      };

      // Safety timeout — if onended never fires (browser bug, tab suspend),
      // force completion so the session doesn't get stuck.
      const timeoutSec = (stage.duration ?? 60) + 5;
      this.stageTimeoutId = setTimeout(() => {
        if (!resolved) {
          log.warn('narration', `Stage audio timed out after ${timeoutSec}s: ${stageName}`);
          audio.pause();
          done('timeout');
        }
      }, timeoutSec * 1000);

      // Seek to offset if resuming mid-block (e.g. timeline scrub)
      if (offset > 0) {
        audio.currentTime = offset;
      }

      audio.play().then(() => {
        // Audio clock binding is now handled by the animate loop's
        // edge detection (narration.isPlayingStage → timeline.bindAudio)
      }).catch(() => {
        log.warn('narration', `Stage audio play() rejected: ${stageName}`);
        done('play-rejected');
      });
    });
  }

  /**
   * Called by the animate loop when a narration block starts.
   * Sets the current stage name, stops old playback, and starts stage audio if available.
   * @param offset Seconds into the audio to start (for seeking into middle of a block)
   */
  enterStage(stageName: string, offset = 0): void {
    this.currentStageName = stageName;
    this.stopStagePlayback();
    if (this.hasStageAudio(stageName)) {
      this.playStage(stageName, offset);
    }
  }

  /**
   * Called by the animate loop when timeline text changes (non-audio segments).
   * Speaks via TTS if no stage audio is playing for this stage.
   */
  speakText(text: string): void {
    if (this.isPlayingStage || this.hasStageAudio(this.currentStageName)) return;
    this.speak(text);
  }

  /** Check if a stage has continuous audio available */
  hasStageAudio(stageName: string): boolean {
    if (!this.manifest) return false;
    const stage = this.manifest.stages.find(s => s.name === stageName);
    return !!(stage?.file);
  }

  /** Get the duration of a stage's pre-recorded audio, or null if no audio */
  getStageAudioDuration(stageName: string): number | null {
    if (!this.manifest) return null;
    const stage = this.manifest.stages.find(s => s.name === stageName);
    if (!stage?.file) return null;
    return stage.duration ?? null;
  }

  get isPlayingStage(): boolean {
    return this.stagePlaybackActive;
  }

  /** Get the current stage audio element (for direct time sync) */
  get stageAudioElement(): HTMLAudioElement | null {
    return this.stageAudio;
  }

  /** Set callback for when stage audio finishes playing */
  setStageEndedHandler(handler: () => void): void {
    this.onStageEnded = handler;
  }

  /** Stop continuous stage playback */
  stopStagePlayback(): void {
    if (this.stageTimeoutId) {
      clearTimeout(this.stageTimeoutId);
      this.stageTimeoutId = null;
    }
    if (this.stageAudio) {
      this.stageAudio.onended = null;
      this.stageAudio.onerror = null;
      this.stageAudio.pause();
      this.stageAudio = null;
    }
    if (this.stageMediaSource) {
      try { this.stageMediaSource.disconnect(); } catch { /* ok */ }
      this.stageMediaSource = null;
    }
    this.stagePlaybackActive = false;
    this._isSpeaking = false;
    this.stageLines = [];
    this.stageCurrentLine = -1;
  }

  /** Play an interactive audio clip by ID (e.g. "breath_intro", "gate_deeper").
   *  Returns a promise that resolves when playback finishes. */
  async playClip(id: string): Promise<void> {
    const entry = this.interactiveLookup.get(id);
    if (!entry) {
      log.warn('narration', `Interactive clip not found: ${id}`);
      return;
    }
    await this.playAudioFile(entry.file, entry.duration);
  }

  /** Check if a manifest with interactive clips is loaded */
  hasClip(id: string): boolean {
    return this.interactiveLookup.has(id);
  }

  /** Update config on the fly */
  setConfig(config: Partial<NarrationConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.preferredVoice) {
      this.selectVoice();
    }
  }

  /**
   * Warm up the speech synthesis — MUST be called from a user gesture (click/tap).
   * Chrome blocks speechSynthesis.speak() if it hasn't been triggered by a gesture.
   * Call this from your "start session" click handler.
   */
  warmup(): void {
    if (this.warmedUp) return;
    // Speak an empty utterance to unlock the API
    const utterance = new SpeechSynthesisUtterance('');
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
    this.warmedUp = true;
    log.info('narration', 'Speech synthesis warmed up');
  }

  /** Queue narration lines to play in order */
  enqueue(lines: NarrationLine[]): void {
    this.queue.push(...lines);
    if (!this.processingQueue) {
      this.processQueue();
    }
  }

  /** Queue a single line */
  speak(text: string, pause?: number, emphasis?: NarrationLine['emphasis']): void {
    this.enqueue([{ text, pause, emphasis }]);
  }

  /** Clear queue and stop current narration */
  stop(): void {
    this.queue = [];
    this.currentLine = null;
    this._displayLine = null;
    this._isSpeaking = false;
    this._active = false;
    this._voiceEnergy = 0;
    this._lineProgress = 0;
    this.processingQueue = false;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.stopStagePlayback();
    window.speechSynthesis.cancel();
  }

  /** Pause narration (keeps queue intact) */
  pause(): void {
    this.paused = true;
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.pause();
    }
  }

  /** Resume narration */
  resume(): void {
    this.paused = false;
    if (window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  }

  /** Call every frame to update voice energy and current line state */
  update(): void {
    // Continuous stage playback — derive current line from audio time (pull model)
    if (this.stagePlaybackActive && this.stageAudio) {
      const t = this.stageAudio.currentTime;

      for (let i = 0; i < this.stageLines.length; i++) {
        const line = this.stageLines[i];
        if (t >= line.startTime && (i === this.stageLines.length - 1 || t < this.stageLines[i + 1].startTime)) {
          if (i !== this.stageCurrentLine) {
            this.stageCurrentLine = i;
            this._displayLine = { text: line.text, words: line.words, startTime: line.startTime };
          }
          break;
        }
      }
    } else {
      this._displayLine = null;
    }

    if (!this._isSpeaking) {
      this._voiceEnergy *= 0.9;
      return;
    }

    const now = performance.now() / 1000;
    const elapsed = now - this.speechStartTime;
    this._lineProgress = this.estimatedDuration > 0
      ? Math.min(1, elapsed / this.estimatedDuration)
      : 0;

    const syllableRate = 4.5;
    const syllablePhase = elapsed * syllableRate * Math.PI * 2;
    const base = 0.5 + 0.3 * Math.sin(syllablePhase);
    const variation = 0.15 * Math.sin(syllablePhase * 0.7 + 1.3);
    const breathEnvelope = Math.sin(this._lineProgress * Math.PI);

    this._voiceEnergy = Math.max(0, Math.min(1,
      (base + variation) * breathEnvelope * 0.8
    ));
  }

  /** Current narration state */
  get state(): NarrationState {
    return {
      isSpeaking: this._isSpeaking,
      currentText: this.currentLine?.text ?? '',
      lineProgress: this._lineProgress,
      voiceEnergy: this._voiceEnergy,
      active: this._active,
    };
  }

  get isVoiceEnabled(): boolean {
    return this.config.voiceEnabled;
  }

  // ── Internal ──

  private loadVoices(): void {
    const trySelect = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        this.voicesLoaded = true;
        this.selectVoice();
        log.info('narration', `Loaded ${voices.length} voices, selected: ${this.selectedVoice?.name ?? 'none'}`);
      }
    };

    trySelect();
    window.speechSynthesis.addEventListener('voiceschanged', trySelect);
  }

  private selectVoice(): void {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return;

    if (this.config.preferredVoice) {
      const pref = this.config.preferredVoice.toLowerCase();
      const match = voices.find(v =>
        v.name.toLowerCase().includes(pref) ||
        v.lang.toLowerCase().includes(pref)
      );
      if (match) {
        this.selectedVoice = match;
        return;
      }
    }

    const english = voices.filter(v => v.lang.startsWith('en'));

    // Premium/natural voices first — these sound the most human
    const premium = english.find(v => {
      const name = v.name.toLowerCase();
      return name.includes('natural') || name.includes('premium') || name.includes('enhanced');
    });

    // Fallback: any English voice
    this.selectedVoice = premium ?? english[0] ?? voices[0] ?? null;
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;
    this._active = true;

    while (this.queue.length > 0) {
      if (this.paused) {
        await this.waitUntilResumed();
      }

      const line = this.queue.shift()!;
      this.currentLine = line;

      // Check for pre-generated audio file first
      const audioEntry = this.audioLookup.get(line.text.trim().toLowerCase());

      // Set current line state (pull model — animate loop reads this)
      this._displayLine = { text: line.text, words: audioEntry?.words, startTime: 0 };

      if (audioEntry) {
        // Play pre-generated audio file
        await this.playAudioFile(audioEntry.file, audioEntry.duration);
      } else if (this.config.voiceEnabled) {
        // Fall back to browser TTS
        await this.speakLine(line);
      } else {
        // No voice — just wait based on estimated reading time
        const words = line.text.split(/\s+/).length;
        const readTime = (words / 2.5) * 1000;
        this._isSpeaking = true;
        this.speechStartTime = performance.now() / 1000;
        this.estimatedDuration = readTime / 1000;
        await this.wait(readTime);
        this._isSpeaking = false;
      }

      // Pause between lines — shorter for pre-generated audio (natural pauses baked in)
      const defaultPause = audioEntry ? 0.3 : 2; // 300ms for audio files, 2s for TTS
      const pauseDuration = (line.pause ?? defaultPause) * 1000;
      if (pauseDuration > 0) {
        await this.wait(pauseDuration);
      }
    }

    this.currentLine = null;
    this._active = false;
    this.processingQueue = false;
  }

  /** Play a pre-generated audio file and simulate voice energy */
  private playAudioFile(file: string, duration: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const audio = new Audio(file);
      audio.volume = this.config.volume;
      this.currentAudio = audio;

      this._isSpeaking = true;
      this.speechStartTime = performance.now() / 1000;
      this.estimatedDuration = duration;

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        this._isSpeaking = false;
        this._voiceEnergy = 0;
        this.currentAudio = null;
        resolve();
      };

      audio.onended = done;
      audio.onerror = () => {
        log.warn('narration', `Failed to play audio: ${file}`);
        done();
      };

      // Safety timeout
      setTimeout(() => {
        if (!resolved) {
          log.warn('narration', 'Audio playback timed out');
          audio.pause();
          done();
        }
      }, (duration + 5) * 1000);

      log.info('narration', `Playing: ${file} (${duration.toFixed(1)}s)`);
      audio.play().catch(() => done());
    });
  }

  private speakLine(line: NarrationLine): Promise<void> {
    return new Promise<void>((resolve) => {
      // Chrome bug: cancel any stale state before speaking
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(line.text);

      if (this.selectedVoice) {
        utterance.voice = this.selectedVoice;
      }

      // Apply emphasis
      switch (line.emphasis) {
        case 'soft':
          utterance.rate = this.config.rate * 0.85;
          utterance.pitch = this.config.pitch * 1.05;
          utterance.volume = this.config.volume * 0.7;
          break;
        case 'deep':
          utterance.rate = this.config.rate * 0.75;
          utterance.pitch = this.config.pitch * 0.85;
          utterance.volume = this.config.volume;
          break;
        default:
          utterance.rate = this.config.rate;
          utterance.pitch = this.config.pitch;
          utterance.volume = this.config.volume;
      }

      // Estimate duration
      const words = line.text.split(/\s+/).length;
      this.estimatedDuration = (words / (2.5 * utterance.rate));
      this.speechStartTime = performance.now() / 1000;
      this._isSpeaking = true;

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        this._isSpeaking = false;
        this._voiceEnergy = 0;
        resolve();
      };

      utterance.onend = done;

      utterance.onerror = (e) => {
        log.warn('narration', 'Speech error', e.error);
        done();
      };

      // Safety timeout — Chrome sometimes never fires onend
      // Give it estimated duration + generous buffer
      const timeoutMs = (this.estimatedDuration + 5) * 1000;
      setTimeout(() => {
        if (!resolved) {
          log.warn('narration', 'Speech timed out, advancing queue');
          window.speechSynthesis.cancel();
          done();
        }
      }, timeoutMs);

      log.info('narration', `Speaking: "${line.text.substring(0, 40)}..." voice=${this.selectedVoice?.name ?? 'default'}`);
      window.speechSynthesis.speak(utterance);

      // Chrome bug workaround: speechSynthesis can pause itself after ~15s.
      // Periodically poke it with resume() to keep it alive.
      const keepAlive = setInterval(() => {
        if (resolved) {
          clearInterval(keepAlive);
          return;
        }
        if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
          // Still going — poke it to prevent Chrome's internal pause
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 10000);
    });
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.pauseTimer = setTimeout(resolve, ms);
    });
  }

  private waitUntilResumed(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.paused) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  /** Get available voice names (for settings UI) */
  getAvailableVoices(): string[] {
    return window.speechSynthesis.getVoices()
      .filter(v => v.lang.startsWith('en'))
      .map(v => v.name);
  }

  // ── Bus-driven lifecycle ──────────────────────────────────────
  private busUnsubs: Array<() => void> = [];
  private bus: EventBus | null = null;
  private currentStageName = '';

  connectBus(bus: EventBus): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
    this.bus = bus;

    // Text display is now pull-model: animate loop reads narration.currentLine each frame.
    // No bus emission needed.

    // Session starting → load manifest
    this.busUnsubs.push(bus.on('session:starting', ({ session }) => {
      this.clearManifest();
      this._manifestPromise = this.loadManifest(`audio/${session.id}/manifest.json`).catch(() => {});
      this.warmup();
    }));

    // NOTE: stage:text and stage:changed are now handled by the pull-model
    // animate loop in main.ts. Narration is called directly via
    // enterStage() and speakText() instead of through bus events.

    // Session ended → stop everything
    this.busUnsubs.push(bus.on('session:ended', () => {
      this.stop();
    }));

    // Settings → update config
    this.busUnsubs.push(bus.on('settings:changed', ({ settings: s }) => {
      this.setConfig({ voiceEnabled: s.ttsEnabled, volume: s.narrationVolume });
    }));
  }

  dispose(): void {
    for (const u of this.busUnsubs) u();
    this.busUnsubs = [];
    this.stop();
  }
}
