/**
 * AudioAnalyzer — extracts frequency band energy from a Web Audio AnalyserNode.
 *
 * Provides smooth 0-1 values for bass, mid, high bands and overall energy,
 * plus a raw frequency data array for custom visualizations.
 * Think Windows Media Player tunnel visualizer — this is what drives it.
 */

export interface AudioBands {
  /** Overall energy 0-1 */
  energy: number;
  /** Low frequencies (sub-bass + bass, ~20-250Hz) */
  bass: number;
  /** Mid frequencies (~250-2000Hz) */
  mid: number;
  /** High frequencies (~2000-16000Hz) */
  high: number;
  /** Raw normalized frequency data (0-1 per bin) — use for custom viz */
  spectrum: Float32Array;
  /** Peak detector — true on energy spikes (useful for flash effects) */
  isPeak: boolean;
  /** Voice presence — energy concentrated in vocal range (~80-1100Hz) */
  voicePresence: number;
}

export class AudioAnalyzer {
  private analyser: AnalyserNode;
  private freqData: Uint8Array<ArrayBuffer>;
  private timeData: Uint8Array<ArrayBuffer>;
  private spectrum: Float32Array;
  private sampleRate: number;
  private fftSize: number;

  // Smoothing state
  private smoothBass = 0;
  private smoothMid = 0;
  private smoothHigh = 0;
  private smoothEnergy = 0;
  private smoothVoice = 0;

  // Peak detection
  private energyHistory: number[] = [];
  private historyLen = 30; // ~0.5s at 60fps
  private _isPeak = false;

  // Smoothing factor (0 = no smoothing, 1 = frozen)
  private smoothing = 0.8;

  constructor(ctx: AudioContext, fftSize = 1024) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = fftSize;
    this.analyser.smoothingTimeConstant = 0.6;
    this.fftSize = fftSize;
    this.sampleRate = ctx.sampleRate;

    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
  }

  /** The AnalyserNode to connect your audio graph through */
  get node(): AnalyserNode {
    return this.analyser;
  }

  /** Call every frame to update band values */
  update(): AudioBands {
    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.timeData);

    const binCount = this.freqData.length;
    const binWidth = this.sampleRate / this.fftSize;

    // Frequency bin ranges
    const bassEnd = Math.min(Math.floor(250 / binWidth), binCount);
    const midEnd = Math.min(Math.floor(2000 / binWidth), binCount);
    const highEnd = Math.min(Math.floor(16000 / binWidth), binCount);

    // Voice range (~80-1100Hz)
    const voiceStart = Math.floor(80 / binWidth);
    const voiceEnd = Math.min(Math.floor(1100 / binWidth), binCount);

    let bassSum = 0, bassCount = 0;
    let midSum = 0, midCount = 0;
    let highSum = 0, highCount = 0;
    let voiceSum = 0, voiceCount = 0;
    let totalSum = 0;

    for (let i = 0; i < binCount; i++) {
      const val = this.freqData[i] / 255;
      this.spectrum[i] = val;
      totalSum += val;

      if (i < bassEnd) {
        bassSum += val;
        bassCount++;
      } else if (i < midEnd) {
        midSum += val;
        midCount++;
      } else if (i < highEnd) {
        highSum += val;
        highCount++;
      }

      if (i >= voiceStart && i < voiceEnd) {
        voiceSum += val;
        voiceCount++;
      }
    }

    const rawBass = bassCount > 0 ? bassSum / bassCount : 0;
    const rawMid = midCount > 0 ? midSum / midCount : 0;
    const rawHigh = highCount > 0 ? highSum / highCount : 0;
    const rawEnergy = binCount > 0 ? totalSum / binCount : 0;
    const rawVoice = voiceCount > 0 ? voiceSum / voiceCount : 0;

    // Smooth
    const s = this.smoothing;
    this.smoothBass = this.smoothBass * s + rawBass * (1 - s);
    this.smoothMid = this.smoothMid * s + rawMid * (1 - s);
    this.smoothHigh = this.smoothHigh * s + rawHigh * (1 - s);
    this.smoothEnergy = this.smoothEnergy * s + rawEnergy * (1 - s);
    this.smoothVoice = this.smoothVoice * s + rawVoice * (1 - s);

    // Peak detection: current energy significantly above recent average
    this.energyHistory.push(rawEnergy);
    if (this.energyHistory.length > this.historyLen) {
      this.energyHistory.shift();
    }
    const avgEnergy = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
    this._isPeak = rawEnergy > avgEnergy * 1.8 && rawEnergy > 0.15;

    return {
      energy: this.smoothEnergy,
      bass: this.smoothBass,
      mid: this.smoothMid,
      high: this.smoothHigh,
      spectrum: this.spectrum,
      isPeak: this._isPeak,
      voicePresence: this.smoothVoice,
    };
  }

  /** Get the last computed bands without re-analyzing */
  get bands(): AudioBands {
    return {
      energy: this.smoothEnergy,
      bass: this.smoothBass,
      mid: this.smoothMid,
      high: this.smoothHigh,
      spectrum: this.spectrum,
      isPeak: this._isPeak,
      voicePresence: this.smoothVoice,
    };
  }

  /** Adjust smoothing: 0 = raw/twitchy, 0.95 = very smooth/laggy */
  setSmoothing(value: number): void {
    this.smoothing = Math.max(0, Math.min(0.99, value));
  }
}
