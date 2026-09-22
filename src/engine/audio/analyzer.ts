/**
 * AudioAnalyzer — band energies (bass / mid / high / overall) from an
 * AnalyserNode, smoothed for visuals. Also a "voice presence" band.
 */

import type { AudioBands } from '../world/types';

export interface AnalyzerReading extends AudioBands {
  voice: number;
  isPeak: boolean;
}

export class AudioAnalyzer {
  readonly node: AnalyserNode;
  private freq: Uint8Array<ArrayBuffer>;
  private readonly binWidth: number;
  private sBass = 0; private sMid = 0; private sHigh = 0; private sEnergy = 0; private sVoice = 0;
  private history: number[] = [];
  private smoothing = 0.8;
  readonly reading: AnalyzerReading = { energy: 0, bass: 0, mid: 0, high: 0, voice: 0, isPeak: false };

  constructor(ctx: AudioContext, fftSize = 1024) {
    this.node = ctx.createAnalyser();
    this.node.fftSize = fftSize;
    this.node.smoothingTimeConstant = 0.6;
    this.freq = new Uint8Array(this.node.frequencyBinCount);
    this.binWidth = ctx.sampleRate / fftSize;
  }

  setSmoothing(v: number): void { this.smoothing = Math.max(0, Math.min(0.99, v)); }

  update(): AnalyzerReading {
    this.node.getByteFrequencyData(this.freq);
    const n = this.freq.length;
    const bw = this.binWidth;
    const bassEnd = Math.min(Math.floor(250 / bw), n);
    const midEnd = Math.min(Math.floor(2000 / bw), n);
    const highEnd = Math.min(Math.floor(16000 / bw), n);
    const vStart = Math.floor(80 / bw), vEnd = Math.min(Math.floor(1100 / bw), n);
    let bass = 0, bc = 0, mid = 0, mc = 0, high = 0, hc = 0, voice = 0, vc = 0, total = 0;
    for (let i = 0; i < n; i++) {
      const v = (this.freq[i] ?? 0) / 255;
      total += v;
      if (i < bassEnd) { bass += v; bc++; }
      else if (i < midEnd) { mid += v; mc++; }
      else if (i < highEnd) { high += v; hc++; }
      if (i >= vStart && i < vEnd) { voice += v; vc++; }
    }
    const rb = bc ? bass / bc : 0, rm = mc ? mid / mc : 0, rh = hc ? high / hc : 0, re = n ? total / n : 0, rv = vc ? voice / vc : 0;
    const s = this.smoothing;
    this.sBass = this.sBass * s + rb * (1 - s);
    this.sMid = this.sMid * s + rm * (1 - s);
    this.sHigh = this.sHigh * s + rh * (1 - s);
    this.sEnergy = this.sEnergy * s + re * (1 - s);
    this.sVoice = this.sVoice * s + rv * (1 - s);
    this.history.push(re);
    if (this.history.length > 30) this.history.shift();
    const avg = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    const r = this.reading;
    r.energy = this.sEnergy; r.bass = this.sBass; r.mid = this.sMid; r.high = this.sHigh; r.voice = this.sVoice;
    r.isPeak = re > avg * 1.8 && re > 0.15;
    return r;
  }
}
