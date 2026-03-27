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
import type { AudioProfile } from './session';
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
  /** Whether narration stage audio is currently playing */
  isNarrationPlaying: boolean;
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

    // TTS speak (for non-audio narration segments)
    if (state.text && state.textStyle === 'narration' && !input.isNarrationPlaying) {
      speakText = state.text;
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

