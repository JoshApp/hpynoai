/**
 * Session frame derivation — pure function, no side effects.
 *
 * Given timeline state + narration state, produces the Config and audio preset
 * that should be applied this frame. Separates "what should happen" from
 * "apply it to subsystems", eliminating cascading failures when one step fails.
 */

import type { TimelineState } from './timeline';
import type { Config, ActorDirective, Preset } from './compositor/types';
import type { AudioPreset } from './audio-compositor';
import type { AudioProfile, SessionStage } from './session';
import type { WordTimestamp } from './narration';
import { buildStageAudioPreset } from './audio-presets';

// ── Input (everything the derivation needs, no side effects) ──

export interface FrameInput {
  /** Current timeline state (fresh from mediaController.tick()) */
  state: TimelineState;
  /** Whether this is a fresh tick (vs. stale/paused fallback) */
  isFreshTick: boolean;
  /** Current fade amount from transition manager */
  fadeAmount: number;
  /** Session audio profile */
  audioProfile: AudioProfile;
  /** Binaural volume from settings */
  binauralVolume: number;
  /** Last stage index (to detect stage changes) */
  lastStageIndex: number;
  /** Narration pull-model state */
  narration: {
    isPlayingStage: boolean;
    stageAudioElement: HTMLAudioElement | null;
    stageWordStream: Readonly<{ words: WordTimestamp[]; text: string }> | null;
  };
  /** Whether media controller is currently playing */
  isPlaying: boolean;
}

// ── Output (pure data, caller decides how to apply) ──

export interface SessionFrame {
  /** Visual compositor config (preset + actor directives) */
  config: Config;
  /** Audio preset to apply on stage change (null = no change needed) */
  audioPreset: {
    preset: Partial<AudioPreset>;
    rampTime: number;
    silenceDip: boolean;
  } | null;
  /** Whether to pause at an interaction boundary */
  pauseAtBoundary: boolean;
  /** Updated last stage index (caller should persist this) */
  newStageIndex: number;
  /** Text to speak via TTS (side effect — only set for narration-tts style) */
  speakText: string | null;
}

/**
 * Derive a complete session frame from timeline + narration state.
 * Pure function — no side effects, no DOM access, fully testable.
 */
export function deriveSessionFrame(input: FrameInput): SessionFrame {
  const { state, isFreshTick, fadeAmount, lastStageIndex } = input;

  // Always build the visual preset (even when paused, keeps tunnel alive)
  const preset: Preset = {
    tunnel: { intensity: state.intensity, spiralSpeed: state.spiralSpeed, audioReactivity: 1 },
    feedback: { strength: state.intensity },
    camera: { sway: state.intensity },
    fade: { opacity: fadeAmount },
  };

  const actors: ActorDirective[] = [];
  let audioPreset: SessionFrame['audioPreset'] = null;
  let pauseAtBoundary = false;
  let newStageIndex = lastStageIndex;
  let speakText: string | null = null;

  // Only build directives from fresh ticks (not stale/paused state)
  if (isFreshTick) {
    // Breath
    if (state.breathDrive && state.breathValue !== null && state.breathStage) {
      actors.push({ type: 'breath', directive: { action: 'drive', value: state.breathValue, stage: state.breathStage } });
    } else if (state.blockJustChanged) {
      actors.push({ type: 'breath', directive: { action: 'apply-stage', stage: state.block.stage } });
    }

    // Audio clip
    actors.push({ type: 'audio-clip', directive: { clip: state.audioClip ?? null } });

    // Text
    const textDirective = deriveTextDirective(state, input.narration);
    actors.push(textDirective);
    // Flag TTS text for the caller to speak (side effect, can't do here)
    if (textDirective.type === 'text' && 'mode' in textDirective.directive
        && textDirective.directive.mode === 'narration-tts') {
      speakText = (textDirective.directive as { text: string }).text;
    }

    // Stage audio preset (on stage change or seek)
    if (state.block.stageIndex !== lastStageIndex || state.seeked) {
      newStageIndex = state.block.stageIndex;
      audioPreset = {
        preset: buildStageAudioPreset(state.block.stage, input.audioProfile, input.binauralVolume),
        rampTime: 3,
        silenceDip: state.block.stage.fractionationDip != null,
      };
    }

    // Interaction boundary
    if (state.atBoundary && input.isPlaying) {
      pauseAtBoundary = true;
    }
  }

  return {
    config: { preset, actors },
    audioPreset,
    pauseAtBoundary,
    newStageIndex,
    speakText,
  };
}

/** Derive the text actor directive from timeline + narration state */
function deriveTextDirective(
  state: TimelineState,
  narration: FrameInput['narration'],
): ActorDirective {
  const wordStream = narration.stageWordStream;
  if (wordStream && wordStream.words.length > 0 && narration.isPlayingStage) {
    return { type: 'text', directive: {
      mode: 'focus',
      text: wordStream.text,
      words: wordStream.words as Array<{ word: string; start: number; end: number }>,
      audioRef: narration.stageAudioElement,
      lineStart: 0,
    }};
  }
  if (state.text) {
    if (state.textStyle === 'cue') return { type: 'text', directive: { mode: 'cue', text: state.text, depth: state.slotDepth ?? undefined } };
    if (state.textStyle === 'prompt') return { type: 'text', directive: { mode: 'prompt', text: state.text } };
    return { type: 'text', directive: { mode: 'narration-tts', text: state.text } };
  }
  return { type: 'text', directive: { mode: 'clear' } };
}
