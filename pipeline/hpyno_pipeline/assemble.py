"""
Turn a parsed session into stage audio, cues, and text timings.

Per stage: items are grouped into render segments (text between silences);
each segment becomes one or more provider requests, stitched with context.
Audio is concatenated with exact silences; word timings come straight from
the provider and are offset by the segment's position in the stage.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from . import dsp
from .align import align_line, WordTime
from .providers import Cached, CacheOnly, RenderRequest, SR
from .script import (Session, Stage, TextItem, SilenceItem, BreakItem, GateItem, BreathItem,
                     TriggerItem, SplitItem, Line, VoiceSettings)

GAP = 0.35            # natural gap between stitched requests
V3_MODELS = ('eleven_v3', 'eleven_v3_conversational')


@dataclass
class LineTiming:
    text: str
    start: float
    end: float
    words: list[WordTime]


@dataclass
class StageResult:
    name: str
    audio: np.ndarray                          # stereo float32
    duration: float
    lines: list[LineTiming]
    cues: list[dict]                           # stage-relative t
    billed_chars: int
    cache_hits: int
    requests: int


@dataclass
class Segment:
    """One provider request worth of text, with the lines it contains."""
    lines: list[Line]
    text: str
    gate: Optional[GateItem] = None            # a gate question ends this segment
    breaks: list[float] = field(default_factory=list)


def _is_v3(model: str) -> bool:
    return model in V3_MODELS


def _clean_for_model(text: str, model: str) -> str:
    """v2 models don't understand delivery tags — strip them."""
    if _is_v3(model): return text
    return re.sub(r'\s+', ' ', re.sub(r'\[[a-z][a-z ]*\]', ' ', text)).strip()


def build_segments(session: Session, st: Stage, max_chars: int) -> list[tuple[Segment | SilenceItem | BreathItem | TriggerItem, ...]]:
    """Linear plan for a stage: a flat list of Segment / SilenceItem / BreathItem / TriggerItem."""
    model = session.stage_model(st)
    plan: list = []
    cur: list[Line] = []
    cur_breaks: list[float] = []

    def flush(gate: Optional[GateItem] = None) -> None:
        nonlocal cur, cur_breaks
        if not cur and gate is None: return
        lines = list(cur)
        parts = [_clean_for_model(l.text, model) for l in lines]
        if gate is not None:
            lines.append(Line(text=gate.prompt)); parts.append(_clean_for_model(gate.prompt, model))
        # split into requests under max_chars at line boundaries
        chunk: list[Line] = []; chunk_txt: list[str] = []; size = 0
        for l, p in zip(lines, parts):
            if size + len(p) + 1 > max_chars and chunk:
                plan.append(Segment(chunk, ' '.join(chunk_txt), None, cur_breaks)); cur_breaks = []
                chunk, chunk_txt, size = [], [], 0
            chunk.append(l); chunk_txt.append(p); size += len(p) + 1
        if chunk:
            plan.append(Segment(chunk, ' '.join(chunk_txt), gate, cur_breaks)); cur_breaks = []
        cur = []

    for it in st.items:
        if isinstance(it, TextItem):
            cur.append(it.line)
        elif isinstance(it, BreakItem):
            if _is_v3(model):
                if it.seconds >= 1.0:
                    flush(); plan.append(SilenceItem(it.seconds, 'pause'))
                else:
                    if cur: cur[-1] = Line(cur[-1].text + ' ...', cur[-1].spans)
            else:
                if cur: cur[-1] = Line(cur[-1].text + f' <break time="{min(3.0, it.seconds):.1f}s" />', cur[-1].spans)
        elif isinstance(it, SilenceItem):
            flush(); plan.append(it)
        elif isinstance(it, GateItem):
            flush(gate=it); plan.append(SilenceItem(it.window, 'gate'))
        elif isinstance(it, BreathItem):
            flush(); plan.append(it); plan.append(SilenceItem(it.seconds, 'breath'))
        elif isinstance(it, TriggerItem):
            flush(); plan.append(it)
        elif isinstance(it, SplitItem):
            flush()
    flush()
    return plan


def render_stage(session: Session, st: Stage, provider: Cached | CacheOnly, max_chars: int, ir: Optional[Path],
                 log: Callable[[str], None] = print, seed_base: int = 0, overrides: Optional[dict] = None) -> StageResult:
    ov_cues = (overrides or {}).get('cues', {})
    ov_sil = (overrides or {}).get('silences', {})
    counters: dict[str, int] = {}

    def cue_id(kind: str) -> str:
        n = counters.get(kind, 0); counters[kind] = n + 1
        return f'{st.name}:{kind}:{n}'

    def add_cue(c: dict) -> dict:
        c['id'] = cue_id(c['type'])
        o = ov_cues.get(c['id'])
        if o:
            if 'dt' in o: c['t'] = round(max(0.0, c['t'] + float(o['dt'])), 3)
            if 'window' in o and c['type'] == 'gate': c['window'] = float(o['window'])
            if 'dur' in o and c['type'] == 'breath': c['dur'] = float(o['dur'])
        return c

    model = session.stage_model(st)
    settings = session.stage_settings(st)
    fx = session.stage_fx(st)
    fx_over = (overrides or {}).get('fx', {}).get(st.name)
    if fx_over:
        fx = fx.merged({k: str(v) for k, v in fx_over.items()})
    plan = build_segments(session, st, max_chars)
    segments = [p for p in plan if isinstance(p, Segment)]

    audio = np.zeros(0, dtype=np.float32)
    side_layers: list[tuple[np.ndarray, float, float, float]] = []   # (mono, at, gain_db, pan) mixed after stereo
    lines: list[LineTiming] = []
    cues: list[dict] = []
    billed = 0; hits = 0; reqs = 0
    prev_ids: list[str] = []
    prev_text = ''
    seg_index = 0
    t = 0.0

    def cur_t() -> float: return audio.size / SR

    sil_index = 0
    for item in plan:
        if isinstance(item, SilenceItem):
            secs = float(ov_sil.get(f'{st.name}:silence:{sil_index}', item.seconds)); sil_index += 1
            audio = np.concatenate([audio, dsp.silence(secs)]); continue
        if isinstance(item, BreathItem):
            cues.append(add_cue({'t': round(cur_t(), 3), 'type': 'breath', 'dur': item.seconds - 1.0,
                         'pattern': {'inhale': st.breath[0], 'holdIn': st.breath[1], 'exhale': st.breath[2], 'holdOut': st.breath[3]}, 'guided': True}))
            continue
        if isinstance(item, TriggerItem):
            cues.append(add_cue({'t': round(cur_t(), 3), 'type': 'trigger', 'kind': item.kind})); continue
        seg: Segment = item
        nxt = segments[seg_index + 1].text if seg_index + 1 < len(segments) else ''
        # eleven_v3 rejects previous/next context; v2 models use it for tone continuity.
        stitch = not _is_v3(model)
        req = RenderRequest(text=seg.text, voice=session.voice, model=model, settings=settings,
                            previous_text=prev_text if stitch else '', next_text=nxt if stitch else '',
                            previous_request_ids=tuple(prev_ids[-3:]) if stitch else (),
                            seed=seed_base + seg_index)
        r = provider.render(req)
        reqs += 1; billed += r.billed_chars; hits += 1 if r.cached else 0
        log(f'  [{st.name}] seg {seg_index + 1}/{len(segments)} {len(seg.text)} chars {"(cache)" if r.cached else "(rendered)"}')
        seg_audio, trimmed = dsp.trim_edges(r.audio)
        # The API reports the first character at t=0 even when the audio starts with
        # silence; snap the first word to the real onset so text never leads the voice.
        onset = dsp.first_onset(seg_audio)
        if audio.size > 0: audio = np.concatenate([audio, dsp.silence(GAP)])
        base = cur_t()
        # word timings for each line inside the segment (segment-relative, refined to real onsets)
        wt_all = align_line(seg.text, r.chars, r.starts, r.ends, r.audio.size / SR)
        seg_words: list[WordTime] = []
        for w in wt_all:
            ws, we = max(0.0, w.start - trimmed), max(0.0, w.end - trimmed)
            ws2, we2 = dsp.refine_word_bounds(seg_audio, ws, we)
            seg_words.append(WordTime(w.word, ws2, we2))
        if seg_words and onset is not None and seg_words[0].start < onset - 0.02:
            seg_words[0] = WordTime(seg_words[0].word, onset, max(onset + 0.05, seg_words[0].end))

        # ── timing edits: scale natural pauses, slow command words ──
        edits: list[tuple[float, float, np.ndarray]] = []
        if fx.pause != 1.0:
            for a_w, b_w in zip(seg_words, seg_words[1:]):
                gap = b_w.start - a_w.end
                if gap >= fx.pause_min:
                    extra = min(2.5, gap * (fx.pause - 1.0))
                    if abs(extra) > 0.01:
                        mid = a_w.end + gap / 2
                        edits.append((mid, mid, dsp.silence(extra)) if extra > 0 else (mid + extra / 2, mid - extra / 2, dsp.silence(0)))
        if fx.cmd_stretch != 1.0:
            wcount = 0
            for ln in seg.lines:
                n = len(ln.words)
                for sp in ln.spans:
                    if sp.kind != 'cmd': continue
                    sw = seg_words[wcount + sp.word_start: wcount + sp.word_end]
                    if sw:
                        a0, a1 = int(sw[0].start * SR), int(sw[-1].end * SR)
                        if a1 - a0 > int(0.08 * SR):
                            edits.append((sw[0].start, sw[-1].end, dsp.stretch(seg_audio[a0:a1].copy(), fx.cmd_stretch, 0.0)))
                wcount += n
        if edits:
            seg_audio, remap = dsp.apply_edits(seg_audio, edits)
            seg_words = [WordTime(w.word, remap(w.start), remap(w.end)) for w in seg_words]
            seg_dur = seg_audio.size / SR

        wi = 0
        for ln in seg.lines:
            n = len(ln.words)
            wts = seg_words[wi:wi + n]; wi += n
            if not wts: continue
            words = [WordTime(w.word, base + w.start, base + w.end) for w in wts]
            lines.append(LineTiming(ln.text, words[0].start, words[-1].end, words))
            for sp in ln.spans:
                span_words = words[sp.word_start:sp.word_end]
                if not span_words: continue
                s, e = span_words[0].start - base, span_words[-1].end - base
                if sp.kind == 'cmd':
                    dsp.boost_span(seg_audio, s, e, fx.cmd_db)
                    cues.append(add_cue({'t': round(base + s, 3), 'type': 'trigger', 'kind': 'snap'}))
                elif sp.kind == 'double' and _is_v3(model):
                    dreq = RenderRequest(text=f'[whispers] {sp.text}', voice=session.voice, model=model,
                                         settings=VoiceSettings(stability=min(1, settings.stability + 0.1), similarity=settings.similarity, style=settings.style, speed=settings.speed),
                                         seed=seed_base + 1000 + seg_index)
                    dr = provider.render(dreq); reqs += 1; billed += dr.billed_chars; hits += 1 if dr.cached else 0
                    d_audio, _ = dsp.trim_edges(dr.audio)
                    # whisper sits close on one side, alternating per double
                    side = 0.55 if len(side_layers) % 2 == 0 else -0.55
                    side_layers.append((dsp.lowpass(d_audio, 7000), base + s + 0.15, fx.double_db, side))
                elif sp.kind == 'fade':
                    dsp.fade_span(seg_audio, s, e, fx.fade_db)
                elif sp.kind == 'echo':
                    a0, a1 = int(s * SR), int(e * SR)
                    phrase = seg_audio[a0:a1].copy()
                    gap = fx.echo_gap if fx.echo_gap > 0 else max(0.35, st.breath[0] / 4)
                    for y, off, pan in dsp.echoes(phrase, fx.echo_db, gap):
                        side_layers.append((y, base + e + off, 0.0, pan))
        if audio.size > 0: dsp.soften_resume(seg_audio, 0, 0.12)
        audio = np.concatenate([audio, seg_audio])
        if seg.gate is not None:
            cues.append(add_cue({'t': round(cur_t() + 0.25, 3), 'type': 'gate', 'window': max(1.0, seg.gate.window - 0.6), 'prompt': seg.gate.prompt.rstrip('.').lower()}))
        if r.request_id: prev_ids.append(r.request_id)
        prev_text = seg.text
        seg_index += 1

    # stage-level cues
    cues.insert(0, add_cue({'t': 0.0, 'type': 'anchor', 'mode': st.anchor}))
    cues.insert(0, add_cue({'t': 0.0, 'type': 'pattern', 'pattern': {'inhale': st.breath[0], 'holdIn': st.breath[1], 'exhale': st.breath[2], 'holdOut': st.breath[3]}}))
    cues.insert(0, add_cue({'t': 0.0, 'type': 'intensity', 'value': st.depth, 'ramp': st.depth_ramp}))

    # deep-stage slow-down: stretch the voice and scale every time we computed
    if abs(fx.stretch - 1) >= 1e-3 or abs(fx.pitch) >= 1e-3:
        audio = dsp.stretch(audio, fx.stretch, fx.pitch)
        k = fx.stretch
        lines = [LineTiming(l.text, l.start * k, l.end * k, [WordTime(w.word, w.start * k, w.end * k) for w in l.words]) for l in lines]
        for c in cues: c['t'] = round(c['t'] * k, 3)
        side_layers = [(dsp.stretch(y, fx.stretch, fx.pitch), at * k, g, pan) for (y, at, g, pan) in side_layers]

    # phrase-end reverb send: the last 0.45 s of every line, faded in
    send = None
    if fx.tails > 0:
        send = np.zeros_like(audio)
        for l in lines:
            a, b = int(max(0.0, l.end - 0.45) * SR), int(min(audio.size / SR, l.end + 0.05) * SR)
            if b > a:
                ramp = np.linspace(0, 1, b - a).astype(np.float32)
                send[a:b] = audio[a:b] * ramp

    # polish
    mono = dsp.proximity(audio, fx.proximity)
    stereo = dsp.to_stereo(mono, fx.drift)
    for y, at, g, pan in side_layers:
        stereo = dsp.mix_stereo_at(stereo, y, at, g, pan)
    # reverb space opens with depth: chapel → dome → cathedral
    ir_dir = ir.parent if ir else None
    ir_pick = ir
    if ir_dir:
        name = 'chapel' if st.depth < 0.4 else 'dome' if st.depth < 0.75 else 'cathedral'
        cand = ir_dir / f'{name}.wav'
        if cand.exists(): ir_pick = cand
    stereo = dsp.ffmpeg_polish(stereo, fx.reverb, ir_pick, send=send, tails=fx.tails, denoise_db=fx.denoise, bright=fx.bright, level_db=fx.level)
    return StageResult(st.name, stereo, stereo.shape[0] / SR, lines, cues, billed, hits, reqs)
