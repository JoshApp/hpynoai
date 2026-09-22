"""Emit a session package v2 (see src/content/schema.ts) and update the index."""
from __future__ import annotations

import json
from pathlib import Path

from . import dsp
from .assemble import StageResult
from .script import Session


def write_package(session: Session, results: list[StageResult], out_dir: Path, bed_duration: float | None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    stages, text_stages, cues = [], [], []
    t0 = 0.0
    for i, r in enumerate(results):
        base = f'{i:02d}_{r.name}'
        dur = dsp.encode(r.audio, out_dir / base)
        stages.append({'name': r.name, 'file': f'{base}.webm', 'fileMp3': f'{base}.mp3', 'duration': round(dur, 3)})
        text_stages.append({'name': r.name, 'lines': [
            {'start': round(l.start, 3), 'end': round(l.end, 3), 'text': l.text,
             'words': [{'w': w.word, 's': round(w.start, 3), 'e': round(w.end, 3)} for w in l.words]}
            for l in r.lines]})
        for c in r.cues:
            cc = dict(c); cc['t'] = round(t0 + c['t'], 3); cues.append(cc)
        t0 += dur
    cues.sort(key=lambda c: c['t'])
    pkg = {
        'schema': 2, 'id': session.id, 'title': session.title, 'subtitle': session.subtitle,
        'description': session.description, 'durationSec': round(t0, 1), 'rating': session.rating,
        'tags': session.tags, 'intensity': session.intensity, 'theme': session.theme,
        'audio': {'stages': stages}, 'cues': cues, 'text': {'stages': text_stages},
    }
    if bed_duration:
        pkg['audio']['bed'] = {'file': 'bed.webm', 'fileMp3': 'bed.mp3', 'loop': True, 'gainDb': session.bed['gain']}
    (out_dir / 'session.v2.json').write_text(json.dumps(pkg, indent=1, ensure_ascii=False))
    return pkg


def update_index(public: Path, sessions_dir: Path, order: list[str] | None = None) -> list[str]:
    ids = []
    for p in sorted(sessions_dir.glob('*/session.v2.json')):
        ids.append(p.parent.name)
    if order:
        ids.sort(key=lambda i: (order.index(i) if i in order else 99, i))
    entries = []
    for sid in ids:
        p = json.loads((sessions_dir / sid / 'session.v2.json').read_text())
        colors = (p.get('theme') or {}).get('colors') or {}
        entries.append({
            'id': p['id'], 'title': p['title'], 'subtitle': p.get('subtitle', ''), 'durationSec': p['durationSec'],
            'intensity': p['intensity'], 'rating': p['rating'], 'tags': p['tags'],
            'themePreview': {'c1': colors.get('c1', [0.3, 0.06, 0.14]), 'c2': colors.get('c3', [0.6, 0.35, 0.4])},
        })
    (public / 'sessions.json').write_text(json.dumps({'schema': 2, 'sessions': entries}, indent=2))
    return ids
