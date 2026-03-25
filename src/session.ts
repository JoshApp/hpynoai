/**
 * Session configuration system — type definitions for the configurable
 * hypnotic experience engine. Different "flavors" drive the same engine
 * with different settings (themes, audio, stages, interactions).
 */

// Theme controls shader colors and visual feel
export interface SessionTheme {
  // CSS color for text overlay
  textColor: string;
  textGlow: string;
  // Shader color uniforms (vec3 values as [r,g,b] 0-1)
  primaryColor: [number, number, number];
  secondaryColor: [number, number, number];
  accentColor: [number, number, number];
  bgColor: [number, number, number];
  // Particle color
  particleColor: [number, number, number];
  // Breathing guide border color
  breatheColor: string;
  // Tunnel shape: 0 = geometric, 1 = organic/cervical (optional, defaults to 0)
  tunnelShape?: number;
}

// Audio profile for a session
export interface AudioProfile {
  // Binaural beat stages: [startBeatHz, endBeatHz]
  // e.g. [10, 4] means start at alpha 10Hz, end at theta 4Hz
  binauralRange: [number, number];
  // Carrier frequency for binaural (Hz)
  carrierFreq: number;
  // Drone base frequency (Hz)
  droneFreq: number;
  // Drone fifth interval frequency (Hz)
  droneFifth: number;
  // LFO speed (Hz) — controls how quickly the drone modulates
  lfoSpeed: number;
  // Filter cutoff (Hz)
  filterCutoff: number;
  // Overall warmth/brightness 0-1
  warmth: number;
  // Optional background ambient track (URL or path to audio file)
  // Loaded and looped under the binaural beats
  backgroundTrack?: string;
  // Volume for the background track (0-1, default 0.3)
  backgroundVolume?: number;
}

// An interaction the user performs during a stage
export interface Interaction {
  type: 'focus-target' | 'breath-sync' | 'gate' | 'countdown' | 'voice-gate' | 'hum-sync' | 'affirm';
  // When in the stage this appears (seconds from stage start)
  triggerAt: number;
  // Duration the interaction is active
  duration: number;
  // Extra data depending on type
  data?: {
    text?: string;        // For gates/voice-gates: prompt text
    count?: number;       // For countdown: start number
    targetSize?: number;  // For focus-target: radius in px
    affirmation?: string; // For affirm: text to speak aloud
  };
}

// Breath pattern for a stage — controls inhale/hold/exhale/hold timing
export interface BreathPatternConfig {
  inhale: number;   // seconds
  holdIn?: number;  // seconds (default 0)
  exhale: number;   // seconds
  holdOut?: number;  // seconds (default 0)
}

// Extended stage definition with interactions
export interface SessionStage {
  name: string;
  duration: number;
  intensity: number;
  texts: string[];
  textInterval: number;
  // Breathing cycle duration in seconds (longer = slower breathing)
  // Used as simple equal inhale/exhale if breathPattern is not set
  breathCycle: number;
  // Optional explicit breath pattern (overrides breathCycle)
  breathPattern?: BreathPatternConfig;
  // Spiral speed multiplier (lower = slower, more hypnotic)
  spiralSpeed: number;
  // Optional interactions during this stage
  interactions?: Interaction[];
  // Optional fractionation dip: intensity drops to this value briefly
  // before ramping to stage intensity
  fractionationDip?: number;
  // Optional per-stage ambient sound profile (overrides session defaults)
  ambient?: Partial<import('./ambient').AmbientProfile>;
  // Seconds of silence after this stage (ambient-only interlude)
  interlude?: number;
  // Optional ambient profile during the interlude (defaults to stage ambient)
  interludeAmbient?: Partial<import('./ambient').AmbientProfile>;
}

// ── Block-based timeline types ──────────────────────────────────

import type { ClipType } from './clips';

export interface TimelineBlock {
  clipType: ClipType;
  start: number;              // absolute start (seconds)
  duration: number;
  end: number;                // start + duration
  stage: SessionStage;
  stageIndex: number;
  data: unknown;              // clip-type-specific, cast by the derive function
}

// Complete session configuration
export interface SessionConfig {
  id: string;
  name: string;
  description: string;
  icon: string; // emoji or symbol for the selector
  theme: SessionTheme;
  audio: AudioProfile;
  stages: SessionStage[];
  // Whether to show photosensitivity warning
  photoWarning: boolean;
  // Age gate / content warning text (null = none)
  contentWarning: string | null;
}
