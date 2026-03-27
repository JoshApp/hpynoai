/**
 * WorldInputs builder — shared construction for the per-frame input bag.
 *
 * Used by both the main render loop (non-session context) and sessionTick().
 * Avoids duplicating the field list in two places.
 */

import type { WorldInputs } from './compositor/types';
import type { TimelineState } from './timeline';
import type { AudioAnalyzer } from './audio-analyzer';
import type { BreathController } from './breath';
import type { NarrationEngine } from './narration';
import type { InteractionShaderState } from './interactions';

export interface WorldInputSources {
  timeline: TimelineState | null;
  analyzer: AudioAnalyzer | null;
  narration: NarrationEngine;
  breath: BreathController;
  interactionShader: InteractionShaderState;
  renderTime: number;
  dt: number;
}

export function buildWorldInputs(src: WorldInputSources): WorldInputs {
  return {
    timeline: src.timeline,
    audioBands: src.analyzer?.update() ?? null,
    voiceEnergy: src.narration.state.voiceEnergy,
    narrationBreath: src.narration.isNarrationBreath,
    breathPhase: src.breath.phase,
    breathValue: src.breath.value,
    breathStage: src.breath.stage,
    micActive: false,
    micBoost: 0,
    interactionShader: src.interactionShader,
    renderTime: src.renderTime,
    dt: src.dt,
  };
}
