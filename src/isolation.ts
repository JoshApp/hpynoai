/**
 * Isolation mode — alternative boot paths that skip the selector screen
 * and initialize only the subsystems needed for a specific test/preview mode.
 *
 * URL schema:
 *   ?isolate=block&session=relax&index=2
 *   ?isolate=stage&session=relax&stage=deepening
 *   ?isolate=shader&intensity=0.7&breath=0.5
 *   ?isolate=audio&profile=relax&component=binaural
 *   ?isolate=interaction&type=gate&blocking=true
 */

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
  breath: number;
  spiralSpeed: number;
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

    case 'shader':
      return {
        mode: 'shader',
        intensity: parseFloat(params.get('intensity') ?? '0.5'),
        breath: parseFloat(params.get('breath') ?? '0'),
        spiralSpeed: parseFloat(params.get('spiralSpeed') ?? '1'),
      };

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
