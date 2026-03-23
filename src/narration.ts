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
  private onTextDisplay: ((text: string) => void) | null = null;
  private paused = false;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private processingQueue = false;
  private warmedUp = false;

  constructor(config?: Partial<NarrationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loadVoices();
  }

  /** Set callback for when text should be displayed */
  setTextHandler(handler: (text: string) => void): void {
    this.onTextDisplay = handler;
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
    console.log('[Narration] Speech synthesis warmed up');
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
    this._isSpeaking = false;
    this._active = false;
    this._voiceEnergy = 0;
    this._lineProgress = 0;
    this.processingQueue = false;
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
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

  /** Call every frame to update voice energy simulation */
  update(): void {
    if (!this._isSpeaking) {
      this._voiceEnergy *= 0.9; // decay
      return;
    }

    const now = performance.now() / 1000;
    const elapsed = now - this.speechStartTime;
    this._lineProgress = this.estimatedDuration > 0
      ? Math.min(1, elapsed / this.estimatedDuration)
      : 0;

    // Simulate voice energy with natural speech rhythm
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
        console.log(`[Narration] Loaded ${voices.length} voices, selected: ${this.selectedVoice?.name ?? 'none'}`);
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
    const premium = english.find(v =>
      v.name.toLowerCase().includes('natural') ||
      v.name.toLowerCase().includes('premium') ||
      v.name.toLowerCase().includes('enhanced')
    );
    const female = english.find(v =>
      v.name.toLowerCase().includes('female') ||
      v.name.toLowerCase().includes('samantha') ||
      v.name.toLowerCase().includes('karen') ||
      v.name.toLowerCase().includes('moira')
    );

    this.selectedVoice = premium ?? female ?? english[0] ?? voices[0] ?? null;
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

      // Display text
      if (this.onTextDisplay) {
        this.onTextDisplay(line.text);
      }

      // Voice it
      if (this.config.voiceEnabled) {
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

      // Pause between lines
      const pauseDuration = (line.pause ?? 2) * 1000;
      if (pauseDuration > 0) {
        await this.wait(pauseDuration);
      }
    }

    this.currentLine = null;
    this._active = false;
    this.processingQueue = false;
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
        console.warn('[Narration] Speech error:', e.error);
        done();
      };

      // Safety timeout — Chrome sometimes never fires onend
      // Give it estimated duration + generous buffer
      const timeoutMs = (this.estimatedDuration + 5) * 1000;
      setTimeout(() => {
        if (!resolved) {
          console.warn('[Narration] Speech timed out, advancing queue');
          window.speechSynthesis.cancel();
          done();
        }
      }, timeoutMs);

      console.log(`[Narration] Speaking: "${line.text.substring(0, 40)}..." voice=${this.selectedVoice?.name ?? 'default'}`);
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

  dispose(): void {
    this.stop();
  }
}
