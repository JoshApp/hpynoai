/**
 * MicrophoneEngine — real-time audio analysis for adaptive hypnosis.
 *
 * Signals exposed:
 *   breathPhase    — 0-1 phase of the user's actual breath cycle
 *   breathRate     — detected breaths per minute
 *   isVocalizing   — any sound above threshold
 *   isHumming      — sustained tone detected (narrow frequency band)
 *   humFrequency   — detected hum fundamental frequency (Hz)
 *   silenceDuration — seconds since last vocalization
 *   volume         — current RMS amplitude 0-1
 *   pitchStability — how stable the pitch is (0 = erratic, 1 = monotone)
 *   tranceEstimate — 0-1 estimated trance depth from voice characteristics
 *
 * Uses Web Audio API AnalyserNode for all processing — no external deps.
 */

export interface MicSignals {
  breathPhase: number;
  breathRate: number;
  isVocalizing: boolean;
  isHumming: boolean;
  humFrequency: number;
  silenceDuration: number;
  volume: number;
  pitchStability: number;
  tranceEstimate: number;
  active: boolean;
}

export class MicrophoneEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private timeData = new Uint8Array(0);
  private freqData = new Uint8Array(0);

  // ── Breath detection state ──
  private volumeHistory: number[] = [];
  private volumeHistoryMaxLen = 300; // ~5 seconds at 60fps
  private breathPeaks: number[] = []; // timestamps of detected exhale peaks
  private lastBreathPeak = 0;
  private _breathPhase = 0;
  private _breathRate = 12; // default 12 breaths/min
  private smoothedBreathCycle = 5; // seconds, will adapt

  // ── Vocalization detection ──
  private _isVocalizing = false;
  private _isHumming = false;
  private _humFrequency = 0;
  private lastVocalizationTime = 0;
  private _volume = 0;

  // ── Pitch tracking for trance estimation ──
  private recentPitches: number[] = [];
  private maxPitchHistory = 60;
  private _pitchStability = 0;
  private _tranceEstimate = 0;

  // ── Config ──
  private vocalizationThreshold = 0.04;
  private humThreshold = 0.03;
  private _active = false;

  get signals(): MicSignals {
    const now = performance.now() / 1000;
    return {
      breathPhase: this._breathPhase,
      breathRate: this._breathRate,
      isVocalizing: this._isVocalizing,
      isHumming: this._isHumming,
      humFrequency: this._humFrequency,
      silenceDuration: this._active ? now - this.lastVocalizationTime : 0,
      volume: this._volume,
      pitchStability: this._pitchStability,
      tranceEstimate: this._tranceEstimate,
      active: this._active,
    };
  }

  get active(): boolean {
    return this._active;
  }

  /** Request mic access and start analysis. Returns false if denied. */
  async start(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false, // preserve natural volume for trance estimation
        },
      });

      this.ctx = new AudioContext();
      const source = this.ctx.createMediaStreamSource(this.stream);

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;

      source.connect(this.analyser);
      // Don't connect to destination — we don't want to play back mic audio

      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this._active = true;
      this.lastVocalizationTime = performance.now() / 1000;
      return true;
    } catch {
      console.log('Microphone access denied — running without mic');
      return false;
    }
  }

  /** Call every frame to update all signals. */
  update(): void {
    if (!this._active || !this.analyser) return;

    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);

    const now = performance.now() / 1000;

    this.updateVolume();
    this.updateVocalization(now);
    this.updateHumDetection();
    this.updateBreathDetection(now);
    this.updatePitchTracking();
    this.updateTranceEstimate(now);
  }

  // ── Volume (RMS) ──
  private updateVolume(): void {
    let sum = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const sample = (this.timeData[i] - 128) / 128;
      sum += sample * sample;
    }
    this._volume = Math.sqrt(sum / this.timeData.length);

    // Keep history for breath detection
    this.volumeHistory.push(this._volume);
    if (this.volumeHistory.length > this.volumeHistoryMaxLen) {
      this.volumeHistory.shift();
    }
  }

  // ── Vocalization detection ──
  private updateVocalization(now: number): void {
    this._isVocalizing = this._volume > this.vocalizationThreshold;
    if (this._isVocalizing) {
      this.lastVocalizationTime = now;
    }
  }

  // ── Hum detection: sustained tone = energy in narrow frequency band ──
  private updateHumDetection(): void {
    if (this._volume < this.humThreshold) {
      this._isHumming = false;
      this._humFrequency = 0;
      return;
    }

    // Find the dominant frequency bin
    let maxBin = 0;
    let maxVal = 0;
    // Only check 50-500Hz range (typical humming range)
    const binWidth = (this.ctx?.sampleRate ?? 44100) / (this.analyser?.fftSize ?? 2048);
    const minBin = Math.floor(50 / binWidth);
    const maxBinIdx = Math.floor(500 / binWidth);

    for (let i = minBin; i < maxBinIdx && i < this.freqData.length; i++) {
      if (this.freqData[i] > maxVal) {
        maxVal = this.freqData[i];
        maxBin = i;
      }
    }

    // Check if energy is concentrated (hum) vs spread (speech/noise)
    // Sum energy in a narrow band around the peak vs total energy
    let peakEnergy = 0;
    let totalEnergy = 0;
    const bandWidth = 3; // bins around peak

    for (let i = minBin; i < maxBinIdx && i < this.freqData.length; i++) {
      const val = this.freqData[i] / 255;
      totalEnergy += val * val;
      if (Math.abs(i - maxBin) <= bandWidth) {
        peakEnergy += val * val;
      }
    }

    const concentration = totalEnergy > 0 ? peakEnergy / totalEnergy : 0;

    // Humming: high concentration (>0.3) + sustained volume
    this._isHumming = concentration > 0.3 && this._isVocalizing;
    this._humFrequency = this._isHumming ? maxBin * binWidth : 0;
  }

  // ── Breath detection from volume envelope ──
  private updateBreathDetection(now: number): void {
    if (this.volumeHistory.length < 30) return;

    // Smooth the volume history to find breath cycles
    // Exhale = higher amplitude peak, inhale = valley
    const smoothed = this.smoothArray(this.volumeHistory, 8);
    const len = smoothed.length;

    // Detect peaks (exhale moments)
    if (len > 2) {
      const prev = smoothed[len - 2];
      const curr = smoothed[len - 1];

      // Peak: was rising, now falling, above threshold
      if (prev > curr && prev > this.vocalizationThreshold * 0.5) {
        // Check it's been at least 2s since last peak (prevent double-counting)
        if (now - this.lastBreathPeak > 2) {
          this.breathPeaks.push(now);
          this.lastBreathPeak = now;

          // Keep last 10 peaks
          if (this.breathPeaks.length > 10) {
            this.breathPeaks.shift();
          }

          // Calculate breath rate from peak intervals
          if (this.breathPeaks.length >= 3) {
            const intervals: number[] = [];
            for (let i = 1; i < this.breathPeaks.length; i++) {
              intervals.push(this.breathPeaks[i] - this.breathPeaks[i - 1]);
            }
            const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
            this._breathRate = 60 / avgInterval;
            // Smooth the detected cycle
            this.smoothedBreathCycle = this.smoothedBreathCycle * 0.7 + avgInterval * 0.3;
          }
        }
      }
    }

    // Calculate current breath phase based on time since last peak
    const timeSincePeak = now - this.lastBreathPeak;
    const cycleLen = this.smoothedBreathCycle;
    this._breathPhase = (timeSincePeak % cycleLen) / cycleLen;
  }

  // ── Pitch tracking (for trance depth estimation) ──
  private updatePitchTracking(): void {
    if (!this._isVocalizing) return;

    // Simple autocorrelation pitch detection on time domain data
    const pitch = this.detectPitch();
    if (pitch > 50 && pitch < 500) {
      this.recentPitches.push(pitch);
      if (this.recentPitches.length > this.maxPitchHistory) {
        this.recentPitches.shift();
      }
    }

    // Calculate pitch stability (low std dev = high stability)
    if (this.recentPitches.length > 5) {
      const mean = this.recentPitches.reduce((a, b) => a + b) / this.recentPitches.length;
      const variance = this.recentPitches.reduce((sum, p) => sum + (p - mean) ** 2, 0)
        / this.recentPitches.length;
      const stdDev = Math.sqrt(variance);
      // Normalize: 0Hz stddev = 1.0 stability, 50Hz+ stddev = 0.0
      this._pitchStability = Math.max(0, 1 - stdDev / 50);
    }
  }

  private detectPitch(): number {
    if (!this.ctx) return 0;
    const sampleRate = this.ctx.sampleRate;
    const bufLen = this.timeData.length;

    // Convert to float
    const buf = new Float32Array(bufLen);
    for (let i = 0; i < bufLen; i++) {
      buf[i] = (this.timeData[i] - 128) / 128;
    }

    // Autocorrelation
    const minLag = Math.floor(sampleRate / 500); // 500Hz max
    const maxLag = Math.floor(sampleRate / 50);  // 50Hz min
    let bestCorr = 0;
    let bestLag = minLag;

    for (let lag = minLag; lag < maxLag && lag < bufLen; lag++) {
      let corr = 0;
      for (let i = 0; i < bufLen - lag; i++) {
        corr += buf[i] * buf[i + lag];
      }
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    return bestCorr > 0.01 ? sampleRate / bestLag : 0;
  }

  // ── Trance depth estimation ──
  private updateTranceEstimate(now: number): void {
    // Combine multiple signals:
    // 1. Volume: quieter voice = deeper (weight: 0.3)
    const volumeScore = this._isVocalizing
      ? Math.max(0, 1 - this._volume / 0.15) // quieter = higher score
      : 0.5; // neutral when not speaking

    // 2. Pitch stability: more monotone = deeper (weight: 0.3)
    const stabilityScore = this._pitchStability;

    // 3. Silence duration: longer pauses = deeper (weight: 0.2)
    const silenceSec = now - this.lastVocalizationTime;
    const silenceScore = Math.min(1, silenceSec / 30); // 30s silence = max

    // 4. Breath rate: slower = deeper (weight: 0.2)
    const breathScore = Math.max(0, 1 - (this._breathRate - 4) / 12);
    // 4 bpm = score 1, 16 bpm = score 0

    this._tranceEstimate =
      this._tranceEstimate * 0.95 + // heavy smoothing — trance changes slowly
      (volumeScore * 0.3 + stabilityScore * 0.3 + silenceScore * 0.2 + breathScore * 0.2) * 0.05;
  }

  // ── Utility ──
  private smoothArray(arr: number[], window: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < arr.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - window); j <= Math.min(arr.length - 1, i + window); j++) {
        sum += arr[j];
        count++;
      }
      result.push(sum / count);
    }
    return result;
  }

  /** Get the detected breath cycle length in seconds (for syncing visuals) */
  get detectedBreathCycle(): number {
    return this.smoothedBreathCycle;
  }

  /** Stop mic and clean up */
  dispose(): void {
    this._active = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }
}
