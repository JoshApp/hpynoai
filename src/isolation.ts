/**
 * Isolation mode — alternative boot paths that skip the selector screen
 * and initialize only the subsystems needed for a specific test/preview mode.
 *
 * URL schema:
 *   ?isolate=block&session=relax&index=2
 *   ?isolate=stage&session=relax&stage=deepening
 *   ?isolate=shader&intensity=0.7&breath=0.5
 *   ?isolate=shader&breathPattern=4-2-6-2&bands=0.3,0.5,0.2
 *   ?isolate=audio&profile=relax&component=binaural
 *   ?isolate=interaction&type=gate&blocking=true
 */

import type { BreathPatternConfig } from './session';

export type IsolationMode = 'block' | 'stage' | 'shader' | 'audio' | 'interaction';

export interface BlockIsolation {
  mode: 'block';
  session: string;
  index: number;
}

export interface StageIsolation {
  mode: 'stage';
  session: string;
  stage: string;
}

export interface ShaderIsolation {
  mode: 'shader';
  intensity: number;
  /** Static breath value (0-1), ignored if breathPattern is set */
  breath: number;
  /** Animated breath cycle: inhale-holdIn-exhale-holdOut (seconds) */
  breathPattern: BreathPatternConfig | null;
  spiralSpeed: number;
  /** Simulated audio bands: [bass, mid, high] (0-1 each) */
  bands: [number, number, number] | null;
  /** Enable FeedbackWarp (Milkdrop effect) */
  feedback: boolean;
  /** Show presence wisp */
  presence: boolean;
}

export interface AudioIsolation {
  mode: 'audio';
  profile: string;
  component: 'binaural' | 'drone' | 'ambient' | 'all';
}

export interface InteractionIsolation {
  mode: 'interaction';
  type: string;
  blocking: boolean;
}

export type IsolationConfig =
  | BlockIsolation
  | StageIsolation
  | ShaderIsolation
  | AudioIsolation
  | InteractionIsolation;

/** Parse "4-2-6-2" into a BreathPatternConfig */
function parseBreathPattern(s: string): BreathPatternConfig | null {
  const parts = s.split('-').map(Number);
  if (parts.length < 2 || parts.some(n => !isFinite(n) || n < 0)) return null;
  return {
    inhale: parts[0],
    holdIn: parts[1] ?? 0,
    exhale: parts[2] ?? parts[0],
    holdOut: parts[3] ?? 0,
  };
}

/** Parse "0.3,0.5,0.2" into [bass, mid, high] */
function parseBands(s: string): [number, number, number] | null {
  const parts = s.split(',').map(Number);
  if (parts.length < 3 || parts.some(isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Parse URL search params into an IsolationConfig, or null if not in isolation mode. */
export function parseIsolationParams(): IsolationConfig | null {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('isolate');
  if (!mode) return null;

  switch (mode) {
    case 'block':
      return {
        mode: 'block',
        session: params.get('session') ?? 'relax',
        index: parseInt(params.get('index') ?? '0', 10) || 0,
      };

    case 'stage':
      return {
        mode: 'stage',
        session: params.get('session') ?? 'relax',
        stage: params.get('stage') ?? '',
      };

    case 'shader': {
      const bp = params.get('breathPattern');
      const bands = params.get('bands');
      return {
        mode: 'shader',
        intensity: parseFloat(params.get('intensity') ?? '0.5'),
        breath: parseFloat(params.get('breath') ?? '0'),
        breathPattern: bp ? parseBreathPattern(bp) : null,
        spiralSpeed: parseFloat(params.get('spiralSpeed') ?? params.get('spiral') ?? '1'),
        bands: bands ? parseBands(bands) : null,
        feedback: params.get('feedback') !== 'false',
        presence: params.get('presence') === 'true',
      };
    }

    case 'audio':
      return {
        mode: 'audio',
        profile: params.get('profile') ?? 'relax',
        component: (params.get('component') as AudioIsolation['component']) ?? 'all',
      };

    case 'interaction':
      return {
        mode: 'interaction',
        type: params.get('type') ?? 'gate',
        blocking: params.get('blocking') !== 'false',
      };

    default:
      return null;
  }
}
