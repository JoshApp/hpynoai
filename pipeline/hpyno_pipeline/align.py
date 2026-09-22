"""
Character alignment → word timings, mapped onto the script's own words.

The API returns per-character times for the request text. We derive words
from that, drop delivery tags, then match against the words the script
expects with a tolerant sequence matcher so a dropped or merged token never
shifts the rest of the line.
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass

from .script import words_of

_norm_re = re.compile(r"[^a-z0-9']+")


@dataclass
class WordTime:
    word: str
    start: float
    end: float


def _norm(w: str) -> str:
    return _norm_re.sub('', w.lower())


def words_from_chars(chars: list[str], starts: list[float], ends: list[float]) -> list[WordTime]:
    out: list[WordTime] = []
    buf: list[str] = []
    s0 = 0.0; e0 = 0.0
    depth = 0  # inside [tag]
    for ch, s, e in zip(chars, starts, ends):
        if ch == '[':
            depth += 1; continue
        if ch == ']':
            depth = max(0, depth - 1); continue
        if depth > 0:
            continue
        if ch.isspace():
            if buf:
                out.append(WordTime(''.join(buf), s0, e0)); buf = []
            continue
        if not buf: s0 = s
        buf.append(ch); e0 = e
    if buf:
        out.append(WordTime(''.join(buf), s0, e0))
    return out


def map_to_script(expected: list[str], got: list[WordTime], total_duration: float) -> list[WordTime]:
    """Return one WordTime per expected word. Unmatched words are interpolated."""
    if not expected:
        return []
    a = [_norm(w) for w in expected]
    b = [_norm(w.word) for w in got]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    times: list[WordTime | None] = [None] * len(expected)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                g = got[j1 + k]; times[i1 + k] = WordTime(expected[i1 + k], g.start, g.end)
        elif tag == 'replace' and (i2 - i1) == (j2 - j1):
            for k in range(i2 - i1):
                g = got[j1 + k]; times[i1 + k] = WordTime(expected[i1 + k], g.start, g.end)
        elif tag == 'replace' and j2 > j1:
            # spread the got span evenly over the expected words
            s, e = got[j1].start, got[j2 - 1].end
            n = i2 - i1
            for k in range(n):
                times[i1 + k] = WordTime(expected[i1 + k], s + (e - s) * k / n, s + (e - s) * (k + 1) / n)
    # interpolate gaps
    idx = [i for i, t in enumerate(times) if t is not None]
    if not idx:
        per = total_duration / len(expected)
        return [WordTime(w, i * per, (i + 1) * per) for i, w in enumerate(expected)]
    prev_end = 0.0
    result: list[WordTime] = []
    i = 0
    while i < len(expected):
        if times[i] is not None:
            result.append(times[i]); prev_end = times[i].end; i += 1; continue
        j = i
        while j < len(expected) and times[j] is None: j += 1
        next_start = times[j].start if j < len(expected) else total_duration
        n = j - i
        for k in range(n):
            s = prev_end + (next_start - prev_end) * k / n
            e = prev_end + (next_start - prev_end) * (k + 1) / n
            result.append(WordTime(expected[i + k], s, e))
        i = j
    return result


def align_line(text: str, rendered_chars: list[str], starts: list[float], ends: list[float], duration: float) -> list[WordTime]:
    expected = words_of(text)
    got = words_from_chars(rendered_chars, starts, ends)
    return map_to_script(expected, got, duration)
