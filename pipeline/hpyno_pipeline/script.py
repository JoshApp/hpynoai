"""
Script format v3.

Pipeline markers are UPPERCASE in square brackets: `[STAGE: name]`, `[PAUSE 2]`.
Lowercase bracket tags such as `[whispers]` or `[sighs]` are ElevenLabs v3
delivery tags and pass through untouched inside the text.

Header (before the first stage):
  [SESSION: id]  [TITLE: ..]  [SUBTITLE: ..]  [DESCRIPTION: ..]  [TAGS: a, b]
  [INTENSITY: 3]  [RATING: adult|all]  [VOICE: voice_id]  [MODEL: eleven_v3]
  [SETTINGS: stability=0.4 similarity=0.8 style=0.2 speed=0.9]
  [THEME: shape=1 c1=r,g,b c2=.. c3=.. c4=.. wisp=r,g,b]
  [BED: carrier=110 beat=7-3 drone=55 gain=-4 wind=0.3 duck=0.35 pad=0.16]
  [GATE-WINDOW: 7]   [SEED: 42]

Stage:
  [STAGE: name]  then optional  [DEPTH: 0.3 ramp=12]  [BREATH: 4/1/3/0]  [ANCHOR: breathe]
  [MODEL: ..] [SETTINGS: ..] [FX: reverb=0.08 proximity=0.5 drift=0.2 double=-12 echo=-9 pause=1.5 cmd_stretch=1.15 tails=0.3 stretch=1.04 pitch=-0.5]

Body markers (anywhere in a stage):
  text lines            consecutive lines form one display line; blank line or [SLICE] ends it
  [PAUSE 2.5]           exact digital silence (splits the render request)
  [BREAK 1.5]           short in-request pause (v2: SSML break; v3: converted to a split if ≥1s, else ellipsis)
  [GATE: question?]     question is spoken inline, then a silent answer window; emits a gate cue
  [BREATH-SYNC 24]      breath cue + silence for the guided breathing
  [INTERLUDE 6]         silence
  [CMD phrase]          phrase spoken inline, volume-emphasised, emits a 'snap' trigger at the word
  [DOUBLE phrase]       phrase spoken inline plus a whispered double mixed underneath
  [ECHO phrase]         phrase spoken inline, then three decaying echoes trailing off to the sides
  [FADE phrase]         phrase sinks in volume as it goes (drifting away)
  [TRIGGER: drop|bloom|snap]  visual trigger cue at this point
  [SPLIT]               force a new render request here
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

MARKER_RE = re.compile(r'^\[([A-Z][A-Z0-9-]*)(?::\s*|\s+)?(.*?)\]\s*$')
INLINE_MARKER_RE = re.compile(r'\[(CMD|DOUBLE|ECHO|FADE)\s+([^\]]+)\]')
DELIVERY_TAG_RE = re.compile(r'\[[a-z][a-z ]*\]')


@dataclass
class VoiceSettings:
    stability: float = 0.45
    similarity: float = 0.8
    style: float = 0.15
    speed: float = 0.92
    speaker_boost: bool = True

    def merged(self, kv: dict[str, str]) -> 'VoiceSettings':
        out = VoiceSettings(**self.__dict__)
        for k, v in kv.items():
            if k in ('stability', 'similarity', 'style', 'speed'):
                setattr(out, k, float(v))
            elif k in ('speaker_boost', 'boost'):
                out.speaker_boost = v.lower() in ('1', 'true', 'yes')
        return out


@dataclass
class Fx:
    reverb: float = 0.0        # wet mix 0..1 (convolution)
    proximity: float = 0.0     # 0..1 close-mic warmth
    drift: float = 0.0         # 0..1 slow stereo drift
    double_db: float = -12.0   # level of whispered doubles
    cmd_db: float = 2.5        # emphasis on command words
    echo_db: float = -9.0      # first echo level; each repeat falls 5 dB further
    echo_gap: float = 0.0      # seconds between echoes; 0 = half the stage's inhale time
    stretch: float = 1.0       # time-stretch factor for the whole stage (1.06 = 6% slower)
    pitch: float = 0.0         # semitones (negative = lower)
    pause: float = 1.0         # scale natural gaps between phrases (1.6 = 60% longer pauses)
    pause_min: float = 0.3     # only gaps at least this long count as pauses
    cmd_stretch: float = 1.0   # slow command words by this factor (1.15 = 15% slower)
    tails: float = 0.0         # reverb tail sent from phrase ends (0..1)
    denoise: float = 6.0       # spectral denoise strength in dB (0 = off)
    bright: float = 0.4        # air shelf + exciter amount (0 = none, 1 = full)
    level: float = 0.0         # stage level offset in dB after normalisation (deep stages quieter by design)
    fade_db: float = -9.0      # how far a [FADE] phrase sinks by its end

    def merged(self, kv: dict[str, str]) -> 'Fx':
        out = Fx(**self.__dict__)
        for k, v in kv.items():
            if k == 'reverb': out.reverb = float(v)
            elif k == 'proximity': out.proximity = float(v)
            elif k == 'drift': out.drift = float(v)
            elif k == 'double': out.double_db = float(v)
            elif k == 'cmd': out.cmd_db = float(v)
            elif k == 'echo': out.echo_db = float(v)
            elif k == 'echo_gap': out.echo_gap = float(v)
            elif k == 'stretch': out.stretch = float(v)
            elif k == 'pitch': out.pitch = float(v)
            elif k == 'pause': out.pause = float(v)
            elif k == 'pause_min': out.pause_min = float(v)
            elif k == 'cmd_stretch': out.cmd_stretch = float(v)
            elif k == 'tails': out.tails = float(v)
            elif k == 'denoise': out.denoise = float(v)
            elif k == 'bright': out.bright = float(v)
            elif k == 'level': out.level = float(v)
            elif k == 'fade': out.fade_db = float(v)
        return out


FX_FIELDS: list[tuple[str, str, float, float, float, str]] = [
    # (key, attr, min, max, step, label)
    ('reverb', 'reverb', 0, 0.5, 0.01, 'reverb wet'),
    ('tails', 'tails', 0, 1, 0.05, 'phrase-end tails'),
    ('denoise', 'denoise', 0, 24, 1, 'denoise (dB)'),
    ('bright', 'bright', 0, 1, 0.05, 'brightness (air + exciter)'),
    ('level', 'level', -9, 3, 0.5, 'stage level (dB)'),
    ('fade', 'fade_db', -24, 0, 1, 'fade phrase depth (dB)'),
    ('proximity', 'proximity', 0, 1, 0.05, 'proximity (close mic)'),
    ('drift', 'drift', 0, 1, 0.05, 'stereo drift'),
    ('pause', 'pause', 0.6, 3, 0.05, 'pause scale'),
    ('pause_min', 'pause_min', 0.1, 1, 0.05, 'min gap counted as pause (s)'),
    ('cmd', 'cmd_db', 0, 6, 0.5, 'command boost (dB)'),
    ('cmd_stretch', 'cmd_stretch', 1, 1.5, 0.01, 'command stretch'),
    ('double', 'double_db', -24, 0, 1, 'whisper double (dB)'),
    ('echo', 'echo_db', -24, 0, 1, 'echo level (dB)'),
    ('echo_gap', 'echo_gap', 0, 3, 0.05, 'echo gap (s, 0=auto)'),
    ('stretch', 'stretch', 0.9, 1.2, 0.01, 'stage time-stretch'),
    ('pitch', 'pitch', -3, 3, 0.25, 'pitch (semitones)'),
]


@dataclass
class Span:
    """A marked phrase inside a line (CMD or DOUBLE)."""
    kind: str            # 'cmd' | 'double' | 'echo'
    text: str
    word_start: int      # index into the line's word list
    word_end: int        # exclusive


@dataclass
class Line:
    """One display line: the text ElevenLabs will read, with marked spans."""
    text: str
    spans: list[Span] = field(default_factory=list)

    @property
    def words(self) -> list[str]:
        return words_of(self.text)


# Items inside a stage, in order.
@dataclass
class TextItem:
    line: Line

@dataclass
class SilenceItem:
    seconds: float
    reason: str          # 'pause' | 'interlude' | 'gate' | 'breath'

@dataclass
class BreakItem:
    seconds: float

@dataclass
class GateItem:
    prompt: str
    window: float

@dataclass
class BreathItem:
    seconds: float

@dataclass
class TriggerItem:
    kind: str

@dataclass
class SplitItem:
    pass

Item = TextItem | SilenceItem | BreakItem | GateItem | BreathItem | TriggerItem | SplitItem


@dataclass
class Stage:
    name: str
    items: list[Item] = field(default_factory=list)
    depth: float = 0.5
    depth_ramp: float = 12.0
    breath: tuple[float, float, float, float] = (4, 1, 5, 0)
    anchor: str = 'breathe'
    model: Optional[str] = None
    settings: Optional[VoiceSettings] = None
    fx: Optional[Fx] = None


@dataclass
class Session:
    id: str
    title: str = ''
    subtitle: str = ''
    description: str = ''
    tags: list[str] = field(default_factory=list)
    intensity: int = 3
    rating: str = 'adult'
    voice: str = ''
    model: str = 'eleven_v3'
    settings: VoiceSettings = field(default_factory=VoiceSettings)
    fx: Fx = field(default_factory=Fx)
    theme: dict = field(default_factory=dict)
    bed: dict = field(default_factory=lambda: {'carrier': 110.0, 'beat': (7.0, 3.0), 'drone': 55.0, 'gain': -4.0, 'wind': 0.3, 'duck': 0.35, 'pad': 0.16})
    gate_window: float = 7.0
    seed: int = 42
    stages: list[Stage] = field(default_factory=list)

    def stage_model(self, st: Stage) -> str: return st.model or self.model
    def stage_settings(self, st: Stage) -> VoiceSettings: return st.settings or self.settings
    def stage_fx(self, st: Stage) -> Fx: return st.fx or self.fx


class ScriptError(ValueError):
    def __init__(self, msg: str, lineno: int):
        super().__init__(f'line {lineno}: {msg}')
        self.lineno = lineno


def words_of(text: str) -> list[str]:
    """Words as ElevenLabs will speak them: delivery tags removed, split on whitespace."""
    return [w for w in DELIVERY_TAG_RE.sub(' ', text).split() if w]


def parse_kv(rest: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for tok in rest.split():
        if '=' in tok:
            k, v = tok.split('=', 1)
            out[k.strip().lower()] = v.strip()
    return out


def parse_vec(v: str) -> list[float]:
    return [float(x) for x in v.split(',')]


def _build_line(raw_lines: list[str]) -> Line:
    """Join raw text lines into one Line, extracting [CMD ..] and [DOUBLE ..] spans."""
    joined = ' '.join(l.strip() for l in raw_lines if l.strip())
    spans: list[Span] = []
    out_words: list[str] = []
    pos = 0
    for m in INLINE_MARKER_RE.finditer(joined):
        before = joined[pos:m.start()]
        out_words += words_of(before)
        phrase = m.group(2).strip()
        pw = words_of(phrase)
        spans.append(Span(kind=m.group(1).lower(), text=phrase, word_start=len(out_words), word_end=len(out_words) + len(pw)))
        out_words += pw
        pos = m.end()
    out_words += words_of(joined[pos:])
    # Rebuild text preserving delivery tags: simplest faithful approach is to strip
    # the pipeline markers from the joined string and keep everything else.
    text = INLINE_MARKER_RE.sub(lambda m: m.group(2).strip(), joined)
    text = re.sub(r'\s+', ' ', text).strip()
    return Line(text=text, spans=spans)


def parse_script(src: str) -> Session:
    session: Optional[Session] = None
    header: dict[str, str] = {}
    stage: Optional[Stage] = None
    pending: list[str] = []

    def flush() -> None:
        nonlocal pending
        if pending and stage is not None:
            stage.items.append(TextItem(_build_line(pending)))
        pending = []

    for lineno, raw in enumerate(src.splitlines(), 1):
        line = raw.rstrip()
        if not line.strip():
            flush(); continue
        if line.lstrip().startswith('#'):
            continue
        m = MARKER_RE.match(line.strip())
        if m and m.group(1) in ('CMD', 'DOUBLE', 'ECHO', 'FADE'):
            m = None  # inline span at the start of a text line, not a block marker
        if not m:
            if stage is None:
                raise ScriptError('text before the first [STAGE: ...]', lineno)
            pending.append(line)
            continue
        name, rest = m.group(1), (m.group(2) or '').strip()

        if name == 'STAGE':
            flush()
            if session is None:
                session = _make_session(header, lineno)
            if not rest:
                raise ScriptError('[STAGE: name] needs a name', lineno)
            stage = Stage(name=rest)
            session.stages.append(stage)
            continue

        if stage is None:
            header[name] = rest
            continue

        # Stage-level and body markers
        if name == 'DEPTH':
            kv = parse_kv(rest); val = rest.split()[0] if rest else '0.5'
            stage.depth = float(val); stage.depth_ramp = float(kv.get('ramp', stage.depth_ramp))
        elif name == 'BREATH':
            parts = [float(x) for x in re.split(r'[/,\s]+', rest) if x]
            if len(parts) not in (2, 4): raise ScriptError('[BREATH: in/holdIn/out/holdOut]', lineno)
            stage.breath = (parts[0], parts[1], parts[2], parts[3]) if len(parts) == 4 else (parts[0], 0.0, parts[1], 0.0)
        elif name == 'ANCHOR':
            if rest not in ('settle', 'breathe', 'pendulum', 'speak', 'hidden'): raise ScriptError(f'bad anchor {rest}', lineno)
            stage.anchor = rest
        elif name == 'MODEL':
            stage.model = rest
        elif name == 'SETTINGS':
            stage.settings = (stage.settings or session.settings).merged(parse_kv(rest))
        elif name == 'FX':
            stage.fx = (stage.fx or session.fx).merged(parse_kv(rest))
        elif name == 'SLICE':
            flush()
        elif name == 'PAUSE':
            flush(); stage.items.append(SilenceItem(float(rest or 2.0), 'pause'))
        elif name == 'BREAK':
            flush(); stage.items.append(BreakItem(float(rest or 1.0)))
        elif name == 'INTERLUDE':
            flush(); stage.items.append(SilenceItem(float(rest or 5.0), 'interlude'))
        elif name == 'GATE':
            flush()
            if not rest: raise ScriptError('[GATE: question?] needs text', lineno)
            kv = parse_kv(rest)
            prompt = re.sub(r'\s+window=\S+', '', rest).strip()
            stage.items.append(GateItem(prompt=prompt, window=float(kv.get('window', session.gate_window))))
        elif name == 'BREATH-SYNC':
            flush(); stage.items.append(BreathItem(float(rest or 24.0)))
        elif name == 'TRIGGER':
            flush()
            if rest not in ('drop', 'bloom', 'snap'): raise ScriptError(f'bad trigger {rest}', lineno)
            stage.items.append(TriggerItem(rest))
        elif name == 'SPLIT':
            flush(); stage.items.append(SplitItem())
        else:
            raise ScriptError(f'unknown marker [{name}]', lineno)

    flush()
    if session is None:
        raise ScriptError('no [STAGE: ...] found', 0)
    if not session.stages:
        raise ScriptError('no stages', 0)
    for st in session.stages:
        if not any(isinstance(i, TextItem) for i in st.items):
            raise ScriptError(f'stage "{st.name}" has no text', 0)
    return session


def _make_session(h: dict[str, str], lineno: int) -> Session:
    if 'SESSION' not in h:
        raise ScriptError('[SESSION: id] missing in header', lineno)
    s = Session(id=h['SESSION'].strip())
    s.title = h.get('TITLE', s.id.title())
    s.subtitle = h.get('SUBTITLE', '')
    s.description = h.get('DESCRIPTION', '')
    s.tags = [t.strip() for t in h.get('TAGS', '').split(',') if t.strip()]
    s.intensity = max(1, min(5, int(h.get('INTENSITY', '3'))))
    s.rating = 'all' if h.get('RATING', 'adult').strip() == 'all' else 'adult'
    s.voice = h.get('VOICE', '').strip()
    s.model = h.get('MODEL', 'eleven_v3').strip()
    s.settings = VoiceSettings().merged(parse_kv(h.get('SETTINGS', '')))
    s.fx = Fx().merged(parse_kv(h.get('FX', '')))
    s.gate_window = float(h.get('GATE-WINDOW', '7'))
    s.seed = int(h.get('SEED', '42'))
    if 'THEME' in h:
        kv = parse_kv(h['THEME'])
        colors = {k: parse_vec(kv[k]) for k in ('c1', 'c2', 'c3', 'c4') if k in kv}
        s.theme = {}
        if colors: s.theme['colors'] = colors
        if 'wisp' in kv: s.theme['wisp'] = parse_vec(kv['wisp'])
        if 'shape' in kv: s.theme['shape'] = float(kv['shape'])
    if 'BED' in h:
        kv = parse_kv(h['BED'])
        if 'carrier' in kv: s.bed['carrier'] = float(kv['carrier'])
        if 'beat' in kv:
            a, b = kv['beat'].split('-'); s.bed['beat'] = (float(a), float(b))
        if 'drone' in kv: s.bed['drone'] = float(kv['drone'])
        if 'gain' in kv: s.bed['gain'] = float(kv['gain'])
        if 'wind' in kv: s.bed['wind'] = float(kv['wind'])
        if 'duck' in kv: s.bed['duck'] = float(kv['duck'])
        if 'pad' in kv: s.bed['pad'] = float(kv['pad'])
    return s


def char_count(session: Session) -> dict[str, int]:
    """Characters that will be billed per stage (text only, plus whispered doubles)."""
    out: dict[str, int] = {}
    for st in session.stages:
        n = 0
        for it in st.items:
            if isinstance(it, TextItem):
                n += len(it.line.text)
                n += sum(len(sp.text) for sp in it.line.spans if sp.kind == 'double')
            elif isinstance(it, GateItem):
                n += len(it.prompt)
        out[st.name] = n
    return out
