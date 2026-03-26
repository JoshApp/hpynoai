/**
 * Shared audio helpers used across screens.
 *
 * Extracted from main.ts — opening/closing tones, menu audio init,
 * audio context resume from gesture.
 */

import * as Tone from 'tone';
import type { AudioEngine } from '../audio';
import type { AudioCompositor, AudioPreset } from '../audio-compositor';
import {
  BinauralLayer, DroneLayer, PadLayer, NoiseLayer,
  SubPulseLayer, BreathNoiseLayer, SpatialLayer,
} from '../audio-compositor';
import { log } from '../logger';

/**
 * Resume AudioContext + Tone.js from a user gesture.
 * MUST be called synchronously in click/tap handlers (mobile requirement).
 */
export function resumeAudioFromGesture(audio: AudioEngine): void {
  try {
    const ctx = audio.resumeFromGesture();
    Tone.setContext(ctx);
    Tone.start().catch(() => {});
  } catch { /* ok */ }
}

/**
 * Ensure the audio compositor has all layers initialized.
 * Safe to call multiple times — returns early if already running.
 */
export async function ensureAudioCompositor(
  audio: AudioEngine,
  audioCompositor: AudioCompositor,
): Promise<void> {
  if (audioCompositor['isPlaying']) return;
  if (!audio.masterGainNode) {
    await audio.init();
    if (!audio.masterGainNode) return;
  }
  await audioCompositor.init(audio.masterGainNode);
  audioCompositor.addLayer(new BinauralLayer());
  audioCompositor.addLayer(new DroneLayer());
  audioCompositor.addLayer(new PadLayer());
  audioCompositor.addLayer(new NoiseLayer());
  audioCompositor.addLayer(new SubPulseLayer());
  audioCompositor.addLayer(new BreathNoiseLayer());
  audioCompositor.addLayer(new SpatialLayer());
  try {
    const { WispAudioLayer } = await import('../audio-compositor/layers/wisp-audio');
    audioCompositor.addLayer(new WispAudioLayer());
  } catch { /* ok */ }
}

/** Menu ambient preset — quiet, atmospheric */
export const MENU_AUDIO_PRESET: Partial<AudioPreset> = {
  binaural: { carrierFreq: 120, beatFreq: 10, volume: 0.25 },
  drone: { rootNote: 36, harmonicity: 2, modIndex: 2, volume: 0.2 },
  pad: { chord: [48, 52, 55, 60], filterMax: 800, warmth: 0.5, chorusRate: 0.2, volume: 0.12 },
  noise: { type: 'pink', filterFreq: 300, volume: 0.05 },
  spatial: { rate: 0.05, depth: 0.3 },
  melody: { rootNote: 48, volume: 0, tempo: 0 },
};

/** Whisper preset — menu audio faded to near-silence */
export const MENU_WHISPER_PRESET: Partial<AudioPreset> = {
  pad: { chord: [48, 52, 55, 60], filterMax: 400, warmth: 0.5, chorusRate: 0.2, volume: 0.03 },
  drone: { rootNote: 36, harmonicity: 2, modIndex: 1, volume: 0.02 },
  noise: { type: 'pink', filterFreq: 200, volume: 0.01 },
  binaural: { carrierFreq: 120, beatFreq: 10, volume: 0.03 },
};

/**
 * Opening chime — ethereal rising tone on app start.
 * Sub hit → rising sweep → crystal chord bloom → shimmer ping.
 */
export function playOpeningTone(audio: AudioEngine): void {
  try {
    const now = Tone.now();
    const nodes: Tone.ToneAudioNode[] = [];

    const gain = new Tone.Gain(0.2);
    const reverb = new Tone.Reverb({ decay: 6, wet: 0.75, preDelay: 0.03 });
    const filter = new Tone.Filter({ frequency: 100, type: 'lowpass', Q: 3, rolloff: -24 });
    filter.connect(gain);
    gain.connect(reverb);
    if (audio.masterGainNode) Tone.connect(reverb, audio.masterGainNode);
    nodes.push(gain, reverb, filter);

    // Phase 1: Sub hit
    const sub = new Tone.Oscillator({ type: 'sine', frequency: 40 });
    const subGain = new Tone.Gain(0);
    sub.connect(subGain);
    subGain.connect(filter);
    subGain.gain.setValueAtTime(0, now);
    subGain.gain.linearRampToValueAtTime(0.4, now + 0.05);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
    sub.start(now);
    sub.stop(now + 2);
    nodes.push(sub, subGain);

    // Phase 2: Rising sweep
    const sweep = new Tone.FMSynth({
      harmonicity: 3, modulationIndex: 10,
      oscillator: { type: 'sine' }, modulation: { type: 'sine' },
      envelope: { attack: 0.8, decay: 0.3, sustain: 0.2, release: 2 },
      modulationEnvelope: { attack: 0.5, decay: 0.2, sustain: 0.1, release: 1.5 },
    });
    sweep.volume.value = -8;
    sweep.connect(filter);
    sweep.triggerAttackRelease('C3', 2, now + 0.1);
    sweep.modulationIndex.setValueAtTime(1, now + 0.1);
    sweep.modulationIndex.rampTo(12, 1.5);
    sweep.modulationIndex.rampTo(2, 1);
    nodes.push(sweep);

    filter.frequency.setValueAtTime(100, now);
    filter.frequency.exponentialRampToValueAtTime(3000, now + 1.5);
    filter.frequency.rampTo(800, 2);

    // Phase 3: Crystal chord bloom
    const bells = [
      { harm: 5, mod: 6, env: { attack: 0.1, decay: 0.3, sustain: 0.4, release: 4 }, vol: -10, note: 'C5', time: 0.8, dur: 3 },
      { harm: 7, mod: 4, env: { attack: 0.15, decay: 0.3, sustain: 0.3, release: 5 }, vol: -12, note: 'G5', time: 1.0, dur: 2.5 },
      { harm: 3, mod: 5, env: { attack: 0.2, decay: 0.4, sustain: 0.3, release: 4 }, vol: -11, note: 'E6', time: 1.2, dur: 2 },
    ];
    for (const b of bells) {
      const s = new Tone.FMSynth({
        harmonicity: b.harm, modulationIndex: b.mod,
        envelope: b.env, modulationEnvelope: { attack: b.env.attack * 0.5, decay: 0.2, sustain: 0.2, release: 3 },
      });
      s.volume.value = b.vol;
      s.connect(filter);
      s.triggerAttackRelease(b.note, b.dur, now + b.time);
      nodes.push(s);
    }

    // Phase 4: Shimmer ping
    const ping = new Tone.FMSynth({
      harmonicity: 8, modulationIndex: 12,
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.1, release: 3 },
      modulationEnvelope: { attack: 0.01, decay: 0.05, sustain: 0.05, release: 2 },
    });
    ping.volume.value = -14;
    ping.connect(filter);
    ping.triggerAttackRelease('C7', 0.5, now + 1.8);
    nodes.push(ping);

    setTimeout(() => { for (const n of nodes) n.dispose(); }, 12000);
  } catch { /* audio not ready */ }
}

/** Warm descending tone — gentle bell settling */
export function playClosingTone(audio: AudioEngine): void {
  try {
    const now = Tone.now();
    const synth = new Tone.FMSynth({
      harmonicity: 2, modulationIndex: 3,
      envelope: { attack: 0.5, decay: 1, sustain: 0.3, release: 6 },
      modulationEnvelope: { attack: 0.3, decay: 0.5, sustain: 0.2, release: 4 },
    });
    const gain = new Tone.Gain(0.1);
    const reverb = new Tone.Reverb({ decay: 7, wet: 0.85 });

    synth.connect(gain);
    gain.connect(reverb);
    if (audio.masterGainNode) Tone.connect(reverb, audio.masterGainNode);

    synth.triggerAttackRelease('G5', 2, now);
    synth.triggerAttackRelease('E4', 3, now + 0.8);
    synth.triggerAttackRelease('C4', 4, now + 1.5);

    setTimeout(() => { synth.dispose(); gain.dispose(); reverb.dispose(); }, 12000);
  } catch { /* audio not ready */ }
}
