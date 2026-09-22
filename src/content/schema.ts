/**
 * Session package schema v2.
 *
 * A session is a folder under public/sessions/<id>/ containing
 * `session.v2.json` plus audio files. The voice is split into contiguous
 * stage files (silence and pauses are baked in); the ambient bed is a
 * separate looping file. Cues are absolute seconds along the concatenated
 * stage audio. Text timings are stage-relative seconds.
 */

import type { Vec3, TunnelColors } from '@engine/world/types';

export const SCHEMA_VERSION = 2 as const;

export type Rating = 'adult' | 'all';

export interface SessionSummary {
  id: string;
  title: string;
  subtitle: string;
  durationSec: number;
  intensity: 1 | 2 | 3 | 4 | 5;
  rating: Rating;
  tags: string[];
  cover?: string;
  themePreview?: { c1: Vec3; c2: Vec3 };
}

export interface SessionIndex {
  schema: typeof SCHEMA_VERSION;
  sessions: SessionSummary[];
}

export interface BedTrack {
  /** Preferred file (Opus/WebM). Relative to the package folder. */
  file: string;
  /** MP3 fallback for browsers without Opus. */
  fileMp3?: string;
  loop: boolean;
  gainDb?: number;
}

export interface StageTrack {
  name: string;
  file: string;
  fileMp3?: string;
  duration: number;
}

export interface BreathPatternSpec { inhale: number; holdIn?: number; exhale: number; holdOut?: number }

interface CueBase { id?: string }
export interface BreathCue extends CueBase { t: number; type: 'breath'; dur: number; pattern: BreathPatternSpec; guided?: boolean }
export interface GateCue extends CueBase { t: number; type: 'gate'; window: number; prompt: string }
export interface TriggerCue extends CueBase { t: number; type: 'trigger'; kind: 'drop' | 'bloom' | 'snap' }
export interface AnchorCue extends CueBase { t: number; type: 'anchor'; mode: 'settle' | 'breathe' | 'pendulum' | 'speak' | 'hidden' }
export interface IntensityCue extends CueBase { t: number; type: 'intensity'; value: number; ramp?: number }
export interface PatternCue extends CueBase { t: number; type: 'pattern'; pattern: BreathPatternSpec }

export type Cue = BreathCue | GateCue | TriggerCue | AnchorCue | IntensityCue | PatternCue;
export type CueType = Cue['type'];

export interface WordTiming { w: string; s: number; e: number }
export interface TextLine { start: number; end: number; text: string; words: WordTiming[] }
export interface TextStage { name: string; lines: TextLine[] }

export interface SessionTheme {
  colors?: Partial<TunnelColors>;
  wisp?: Vec3;
  shape?: number;
}

export interface SessionPackage {
  schema: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  durationSec: number;
  rating: Rating;
  tags: string[];
  intensity: 1 | 2 | 3 | 4 | 5;
  theme?: SessionTheme;
  audio: { bed?: BedTrack; stages: StageTrack[] };
  cues: Cue[];
  text?: { stages: TextStage[] };
}

// ── Validation ──

export class ContentError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'ContentError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function num(v: unknown, p: string, min = -Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new ContentError(`expected number >= ${min}`, p);
  return v;
}
function str(v: unknown, p: string): string {
  if (typeof v !== 'string' || !v) throw new ContentError('expected non-empty string', p);
  return v;
}

function pattern(v: unknown, p: string): BreathPatternSpec {
  if (!isObj(v)) throw new ContentError('expected breath pattern', p);
  return {
    inhale: num(v.inhale, `${p}.inhale`, 0.5),
    exhale: num(v.exhale, `${p}.exhale`, 0.5),
    holdIn: v.holdIn === undefined ? 0 : num(v.holdIn, `${p}.holdIn`, 0),
    holdOut: v.holdOut === undefined ? 0 : num(v.holdOut, `${p}.holdOut`, 0),
  };
}

function cue(v: unknown, p: string): Cue {
  if (!isObj(v)) throw new ContentError('expected cue object', p);
  const t = num(v.t, `${p}.t`, 0);
  const c = cueBody(v, p, t);
  if (typeof v.id === 'string' && v.id) c.id = v.id;
  return c;
}

function cueBody(v: Record<string, unknown>, p: string, t: number): Cue {
  switch (v.type) {
    case 'breath': return { t, type: 'breath', dur: num(v.dur, `${p}.dur`, 0), pattern: pattern(v.pattern, `${p}.pattern`), guided: v.guided === true };
    case 'gate': return { t, type: 'gate', window: num(v.window, `${p}.window`, 0), prompt: str(v.prompt, `${p}.prompt`) };
    case 'trigger': {
      const kind = v.kind;
      if (kind !== 'drop' && kind !== 'bloom' && kind !== 'snap') throw new ContentError('bad trigger kind', `${p}.kind`);
      return { t, type: 'trigger', kind };
    }
    case 'anchor': {
      const mode = v.mode;
      if (mode !== 'settle' && mode !== 'breathe' && mode !== 'pendulum' && mode !== 'speak' && mode !== 'hidden') throw new ContentError('bad anchor mode', `${p}.mode`);
      return { t, type: 'anchor', mode };
    }
    case 'intensity': return { t, type: 'intensity', value: num(v.value, `${p}.value`, 0), ramp: v.ramp === undefined ? 0 : num(v.ramp, `${p}.ramp`, 0) };
    case 'pattern': return { t, type: 'pattern', pattern: pattern(v.pattern, `${p}.pattern`) };
    default: throw new ContentError(`unknown cue type ${String(v.type)}`, `${p}.type`);
  }
}

export function parseSessionPackage(raw: unknown): SessionPackage {
  if (!isObj(raw)) throw new ContentError('package is not an object');
  if (raw.schema !== SCHEMA_VERSION) throw new ContentError(`unsupported schema ${String(raw.schema)}, expected ${SCHEMA_VERSION}`, 'schema');
  const id = str(raw.id, 'id');
  const title = str(raw.title, 'title');
  const audio = raw.audio;
  if (!isObj(audio) || !Array.isArray(audio.stages) || audio.stages.length === 0) throw new ContentError('audio.stages must be a non-empty array', 'audio.stages');
  const stages: StageTrack[] = audio.stages.map((s, i) => {
    if (!isObj(s)) throw new ContentError('expected stage object', `audio.stages[${i}]`);
    return {
      name: str(s.name, `audio.stages[${i}].name`),
      file: str(s.file, `audio.stages[${i}].file`),
      fileMp3: typeof s.fileMp3 === 'string' ? s.fileMp3 : undefined,
      duration: num(s.duration, `audio.stages[${i}].duration`, 0.1),
    };
  });
  let bed: BedTrack | undefined;
  if (audio.bed !== undefined) {
    if (!isObj(audio.bed)) throw new ContentError('expected bed object', 'audio.bed');
    bed = {
      file: str(audio.bed.file, 'audio.bed.file'),
      fileMp3: typeof audio.bed.fileMp3 === 'string' ? audio.bed.fileMp3 : undefined,
      loop: audio.bed.loop !== false,
      gainDb: audio.bed.gainDb === undefined ? 0 : num(audio.bed.gainDb, 'audio.bed.gainDb'),
    };
  }
  const total = stages.reduce((a, s) => a + s.duration, 0);
  const cuesRaw = Array.isArray(raw.cues) ? raw.cues : [];
  const cues = cuesRaw.map((c, i) => cue(c, `cues[${i}]`)).sort((a, b) => a.t - b.t);
  for (const c of cues) if (c.t > total + 0.01) throw new ContentError(`cue at ${c.t}s is past the end (${total.toFixed(1)}s)`, 'cues');

  let text: SessionPackage['text'];
  if (raw.text !== undefined) {
    if (!isObj(raw.text) || !Array.isArray(raw.text.stages)) throw new ContentError('text.stages must be an array', 'text.stages');
    text = {
      stages: raw.text.stages.map((ts, i) => {
        if (!isObj(ts)) throw new ContentError('expected text stage', `text.stages[${i}]`);
        const name = str(ts.name, `text.stages[${i}].name`);
        if (!stages.some(s => s.name === name)) throw new ContentError(`text stage "${name}" has no audio stage`, `text.stages[${i}].name`);
        const lines = Array.isArray(ts.lines) ? ts.lines : [];
        return {
          name,
          lines: lines.map((l, j) => {
            const p = `text.stages[${i}].lines[${j}]`;
            if (!isObj(l)) throw new ContentError('expected line', p);
            const words = Array.isArray(l.words) ? l.words : [];
            return {
              start: num(l.start, `${p}.start`, 0),
              end: num(l.end, `${p}.end`, 0),
              text: str(l.text, `${p}.text`),
              words: words.map((w, k) => {
                if (!isObj(w)) throw new ContentError('expected word', `${p}.words[${k}]`);
                return { w: str(w.w, `${p}.words[${k}].w`), s: num(w.s, `${p}.words[${k}].s`, 0), e: num(w.e, `${p}.words[${k}].e`, 0) };
              }),
            };
          }),
        };
      }),
    };
  }

  const intensityRaw = raw.intensity ?? 3;
  const intensity = ([1, 2, 3, 4, 5] as const).find(n => n === intensityRaw) ?? 3;
  const rating: Rating = raw.rating === 'all' ? 'all' : 'adult';

  const theme: SessionTheme | undefined = isObj(raw.theme) ? (raw.theme as SessionTheme) : undefined;

  return {
    schema: SCHEMA_VERSION,
    id, title,
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    durationSec: typeof raw.durationSec === 'number' ? raw.durationSec : total,
    rating,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    intensity,
    theme,
    audio: { bed, stages },
    cues,
    text,
  };
}

export function parseSessionIndex(raw: unknown): SessionIndex {
  if (!isObj(raw) || raw.schema !== SCHEMA_VERSION || !Array.isArray(raw.sessions)) {
    throw new ContentError('sessions index must be { schema: 2, sessions: [] }');
  }
  return {
    schema: SCHEMA_VERSION,
    sessions: raw.sessions.map((s, i) => {
      if (!isObj(s)) throw new ContentError('expected session summary', `sessions[${i}]`);
      const intensityRaw = s.intensity ?? 3;
      return {
        id: str(s.id, `sessions[${i}].id`),
        title: str(s.title, `sessions[${i}].title`),
        subtitle: typeof s.subtitle === 'string' ? s.subtitle : '',
        durationSec: num(s.durationSec, `sessions[${i}].durationSec`, 0),
        intensity: ([1, 2, 3, 4, 5] as const).find(n => n === intensityRaw) ?? 3,
        rating: s.rating === 'all' ? 'all' : 'adult',
        tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
        cover: typeof s.cover === 'string' ? s.cover : undefined,
        themePreview: isObj(s.themePreview) ? (s.themePreview as SessionSummary['themePreview']) : undefined,
      };
    }),
  };
}

/** Stage start offsets (absolute seconds), derived from durations. */
export function stageStarts(pkg: SessionPackage): number[] {
  const out: number[] = [];
  let t = 0;
  for (const s of pkg.audio.stages) { out.push(t); t += s.duration; }
  return out;
}

export function totalDuration(pkg: SessionPackage): number {
  return pkg.audio.stages.reduce((a, s) => a + s.duration, 0);
}
