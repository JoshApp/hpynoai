/**
 * Clip derive functions — pure state derivation for each clip type.
 *
 * Each function takes (elapsed, data) and returns a ClipFrame.
 * The timeline dispatches by clip type. The animate loop reads the frame.
 * No switch statements on clip type anywhere outside this file.
 */

import type { BreathPatternConfig } from './session';
import type { BreathStage } from './breath';

// ── Clip types ───────────────────────────────────────────────────

export type ClipType =
  | 'narration-audio'
  | 'narration-tts'
  | 'breathing-intro'
  | 'breathing-core'
  | 'breathing-outro'
  | 'interaction'
  | 'interlude'
  | 'transition';

export type TextStyle = 'cue' | 'narration' | 'prompt' | 'focus';

// ── ClipFrame — everything the scene needs for one frame ─────────

export interface ClipFrame {
  text: string | null;
  textStyle: TextStyle;
  breathValue: number | null;
  breathStage: BreathStage | null;
  breathDrive: boolean;
  slotDepth: number | null;
  audioClip: string | null;
  presenceMode: 'breathe' | 'session';
  wantsNarrationAudio: boolean;
  narrationStageName: string | null;
  narrationAudioOffset: number;
  atBoundary: boolean;
  isInterlude: boolean;
}

// ── Per-clip-type data (stored on TimelineBlock.data) ────────────

export interface NarrationAudioData {
  stageName: string;
  audioOffset: number;
}

export interface NarrationTTSData {
  texts: string[];
  textInterval: number;
}

export interface BreathIntroData {
  pattern: BreathPatternConfig;
  introText: string;
}

export interface BreathCoreData {
  pattern: BreathPatternConfig;
  breaths: number;
}

export interface BreathOutroData {
  pattern: BreathPatternConfig;
  outroTexts: string[];
}

export interface InterludeData {
  duration: number;
}

export interface InteractionClipData {
  type: string;
  promptText: string;
  blocking: boolean;
  minDuration: number;
}

// ── Breathing math (pure) ────────────────────────────────────────

export function cycleDuration(pat: BreathPatternConfig): number {
  return pat.inhale + (pat.holdIn ?? 0) + pat.exhale + (pat.holdOut ?? 0);
}

function deriveBreath(elapsed: number, pat: BreathPatternConfig): { value: number; stage: BreathStage } {
  const cycle = cycleDuration(pat);
  const t = ((elapsed % cycle) + cycle) % cycle;

  if (t < pat.inhale) {
    return { value: (1 - Math.cos((t / pat.inhale) * Math.PI)) / 2, stage: 'inhale' };
  }
  const afterInhale = pat.inhale + (pat.holdIn ?? 0);
  if (t < afterInhale) {
    return { value: 1, stage: 'hold-in' };
  }
  if (t < afterInhale + pat.exhale) {
    return { value: (1 + Math.cos(((t - afterInhale) / pat.exhale) * Math.PI)) / 2, stage: 'exhale' };
  }
  return { value: 0, stage: 'hold-out' };
}

function breathCueText(stage: BreathStage): string {
  switch (stage) {
    case 'inhale': return 'in';
    case 'hold-in': return 'hold';
    case 'exhale': return 'out';
    case 'hold-out': return 'hold';
  }
}

// ── Default frame (silent, empty) ────────────────────────────────

const EMPTY_FRAME: ClipFrame = {
  text: null, textStyle: 'narration',
  breathValue: null, breathStage: null, breathDrive: false, slotDepth: null,
  audioClip: null, presenceMode: 'session',
  wantsNarrationAudio: false, narrationStageName: null, narrationAudioOffset: 0,
  atBoundary: false, isInterlude: false,
};

// ── Derive functions ─────────────────────────────────────────────

function deriveNarrationAudio(_elapsed: number, data: NarrationAudioData): ClipFrame {
  return {
    ...EMPTY_FRAME,
    // Text comes from narration.displayLine in the animate loop (word-by-word focus)
    wantsNarrationAudio: true,
    narrationStageName: data.stageName,
    narrationAudioOffset: data.audioOffset,
  };
}

function deriveNarrationTTS(elapsed: number, data: NarrationTTSData): ClipFrame {
  let text: string | null = null;
  if (data.texts.length > 0 && data.textInterval > 0) {
    const idx = Math.floor(elapsed / data.textInterval);
    if (idx < data.texts.length) {
      text = data.texts[idx % data.texts.length];
    }
  }
  return { ...EMPTY_FRAME, text, textStyle: 'narration' };
}

function deriveBreathIntro(_elapsed: number, data: BreathIntroData): ClipFrame {
  return {
    ...EMPTY_FRAME,
    text: data.introText,
    textStyle: 'cue',
    breathValue: 0,
    breathStage: 'inhale',
    breathDrive: true,
    audioClip: 'breathing_intro',
    presenceMode: 'breathe',
  };
}

function deriveBreathCore(elapsed: number, data: BreathCoreData): ClipFrame {
  const b = deriveBreath(elapsed, data.pattern);
  return {
    ...EMPTY_FRAME,
    text: breathCueText(b.stage),
    textStyle: 'cue',
    breathValue: b.value,
    breathStage: b.stage,
    breathDrive: true,
    slotDepth: -1.2 + b.value * 0.7,
    audioClip: b.stage === 'inhale' ? 'breathe_in'
      : b.stage === 'exhale' ? 'breathe_out'
      : 'breathe_hold',
    presenceMode: 'breathe',
  };
}

function deriveBreathOutro(elapsed: number, data: BreathOutroData): ClipFrame {
  let text: string | null = null;
  if (data.outroTexts.length > 0) {
    const dur = 5 / data.outroTexts.length; // BREATHING_OUTRO_DURATION / count
    const idx = Math.min(Math.floor(elapsed / dur), data.outroTexts.length - 1);
    text = data.outroTexts[idx];
  }
  return {
    ...EMPTY_FRAME,
    text,
    textStyle: 'cue',
    breathValue: 0,
    breathStage: 'exhale',
    breathDrive: true,
    audioClip: 'breathing_good',
    presenceMode: 'breathe',
  };
}

function deriveInteraction(elapsed: number, data: InteractionClipData, interactionMode: boolean): ClipFrame {
  return {
    ...EMPTY_FRAME,
    text: data.promptText,
    textStyle: 'prompt',
    atBoundary: data.blocking && interactionMode && elapsed >= data.minDuration,
  };
}

function deriveInterlude(): ClipFrame {
  return { ...EMPTY_FRAME, isInterlude: true };
}

function deriveTransition(): ClipFrame {
  return EMPTY_FRAME;
}

// ── Dispatcher ───────────────────────────────────────────────────

type ClipDeriver = (elapsed: number, data: any, interactionMode: boolean) => ClipFrame;

export const clipDerivers: Record<ClipType, ClipDeriver> = {
  'narration-audio': (e, d) => deriveNarrationAudio(e, d),
  'narration-tts': (e, d) => deriveNarrationTTS(e, d),
  'breathing-intro': (e, d) => deriveBreathIntro(e, d),
  'breathing-core': (e, d) => deriveBreathCore(e, d),
  'breathing-outro': (e, d) => deriveBreathOutro(e, d),
  'interaction': (e, d, im) => deriveInteraction(e, d, im),
  'interlude': () => deriveInterlude(),
  'transition': () => deriveTransition(),
};
