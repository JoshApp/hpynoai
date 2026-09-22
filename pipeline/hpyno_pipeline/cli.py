"""
hpyno pipeline CLI.

  python -m hpyno_pipeline validate scripts/surrender.v3.txt
  python -m hpyno_pipeline estimate scripts/surrender.v3.txt
  python -m hpyno_pipeline render   scripts/surrender.v3.txt [--provider mock|elevenlabs] [--stage name] [--no-bed]
  python -m hpyno_pipeline audition --voice ID --text "..." [--models eleven_v3,eleven_multilingual_v2]
  python -m hpyno_pipeline voices
  python -m hpyno_pipeline account
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'public'
SESSIONS = PUBLIC / 'sessions'
CACHE = ROOT / 'content-src' / 'cache'
IR_DIR = ROOT / 'content-src' / 'audio' / 'ir'
AUDITIONS = ROOT / 'content-src' / 'auditions'

MAX_CHARS = {'eleven_v3': 4200, 'eleven_v3_conversational': 4200, 'eleven_multilingual_v2': 9000,
             'eleven_flash_v2_5': 9000, 'eleven_turbo_v2_5': 9000, 'eleven_flash_v2': 9000, 'eleven_turbo_v2': 9000}


def load_env() -> None:
    env = ROOT / '.env'
    if env.exists():
        for line in env.read_text().splitlines():
            if '=' in line and not line.strip().startswith('#'):
                k, v = line.split('=', 1); os.environ.setdefault(k.strip(), v.strip())


def cmd_validate(args) -> int:
    from .script import parse_script, char_count
    s = parse_script(Path(args.script).read_text())
    counts = char_count(s)
    print(f'{s.id}: "{s.title}" — {len(s.stages)} stages, model {s.model}, voice {s.voice or "(none)"}')
    for st in s.stages:
        gates = sum(1 for i in st.items if i.__class__.__name__ == 'GateItem')
        print(f'  {st.name:<12} depth {st.depth:<4} breath {st.breath} anchor {st.anchor:<8} chars {counts[st.name]:>5} gates {gates}')
    print(f'  total chars {sum(counts.values())}')
    if not s.voice: print('warning: no [VOICE: id] in header'); return 1
    return 0


def cmd_estimate(args) -> int:
    from .script import parse_script, char_count
    from .assemble import build_segments
    from .providers import RenderRequest, Cache
    s = parse_script(Path(args.script).read_text())
    cache = Cache(CACHE / 'elevenlabs')
    total = 0; cached = 0
    from .assemble import V3_MODELS
    for i, st in enumerate(s.stages):
        model = s.stage_model(st)
        segs = [p for p in build_segments(s, st, MAX_CHARS.get(model, 4000)) if hasattr(p, 'text')]
        for j, seg in enumerate(segs):
            total += len(seg.text)
            stitch = model not in V3_MODELS
            key = RenderRequest(seg.text, s.voice, model, s.stage_settings(st),
                                previous_text=segs[j - 1].text if stitch and j > 0 else '',
                                next_text=segs[j + 1].text if stitch and j + 1 < len(segs) else '',
                                seed=s.seed + i * 100 + j).key()
            if cache.get(key): cached += len(seg.text)
    print(f'{total} characters in total; {cached} already cached → {total - cached} to bill on render')
    return 0


def overrides_path(script: Path) -> Path:
    return script.with_suffix('').with_suffix('.overrides.json') if script.name.endswith('.v3.txt') else script.with_suffix('.overrides.json')


def cmd_render(args) -> int:
    from .script import parse_script
    from .providers import make_provider, NotCached
    from .assemble import render_stage
    from .bed import render_bed
    from .package import write_package, update_index
    load_env()
    script_path = Path(args.script)
    s = parse_script(script_path.read_text())
    if args.provider == 'elevenlabs' and not s.voice:
        print('script has no [VOICE: id]'); return 1
    provider = make_provider(args.provider, CACHE)
    op = overrides_path(script_path)
    overrides = json.loads(op.read_text()) if op.exists() else None
    if overrides: print(f'overrides: {op.name} ({len(overrides.get("cues", {}))} cues, {len(overrides.get("silences", {}))} silences)')
    out_root = Path(args.out) if args.out else SESSIONS
    out_dir = out_root / s.id
    out_dir.mkdir(parents=True, exist_ok=True)
    ir = IR_DIR / 'chapel.wav'
    started = time.time()
    results = []
    billed = 0; hits = 0; reqs = 0
    for i, st in enumerate(s.stages):
        if args.stage and st.name != args.stage: continue
        print(f'stage {st.name}')
        try:
            r = render_stage(s, st, provider, MAX_CHARS.get(s.stage_model(st), 4000), ir, seed_base=s.seed + i * 100, overrides=overrides)
        except NotCached as e:
            print(f'  not cached — run `render` first: {e}'); return 2
        results.append(r); billed += r.billed_chars; hits += r.cache_hits; reqs += r.requests
        print(f'  → {r.duration:.1f}s, {len(r.lines)} lines, {len(r.cues)} cues')
    if args.stage:
        print('single-stage render: package not written (render all stages to emit a package)'); return 0
    # bed
    bed_dur = None
    if not args.no_bed:
        knots = []; patterns = []; speech = []; t = 0.0
        for st, r in zip(s.stages, results):
            knots.append((t, st.depth)); patterns.append((t, st.breath))
            for l in r.lines:
                for w in l.words: speech.append((t + w.start, t + w.end))
            t += r.duration
        knots.append((t, s.stages[-1].depth))
        bed_dur = render_bed(out_dir, t + 12.0, knots, patterns, carrier=s.bed['carrier'], beat=tuple(s.bed['beat']),
                             drone=s.bed['drone'], wind=s.bed['wind'], pad_level=s.bed.get('pad', 0.16),
                             speech=speech, duck=s.bed.get('duck', 0.35))
        print(f'bed: {bed_dur:.0f}s')
    pkg = write_package(s, results, out_dir, bed_dur)
    ids = update_index(out_root.parent if args.out else PUBLIC, out_root, order=['surrender'])
    print(f'package: {out_dir}/session.v2.json ({pkg["durationSec"]}s, {len(pkg["cues"])} cues); index: {ids}')
    print(f'{reqs} requests, {hits} from cache, {billed} characters billed, {time.time() - started:.0f}s')
    return 0


def cmd_audition(args) -> int:
    from .providers import make_provider, RenderRequest
    from .script import VoiceSettings
    from . import dsp
    load_env()
    if not args.script and not args.voice: print('--voice or --script required'); return 1
    provider = make_provider('elevenlabs', CACHE)
    AUDITIONS.mkdir(parents=True, exist_ok=True)
    if args.script:
        return _audition_stage(args, provider)
    text = args.text or ("[whispers] you chose to be here... something about this... draws you in. "
                         "notice the warmth... beginning... low in your body... spreading. [sighs] "
                         "you already know what you want. it's safe... to want this.")
    models = args.models.split(',')
    settings = VoiceSettings().merged(dict(kv.split('=', 1) for kv in (args.settings or '').split() if '=' in kv))
    for m in models:
        req = RenderRequest(text=text if m.startswith('eleven_v3') else __import__('re').sub(r'\[[a-z ]+\]', '', text), voice=args.voice, model=m, settings=settings, seed=1)
        r = provider.render(req)
        stereo = dsp.to_stereo(r.audio, 0)
        base = AUDITIONS / f'{args.voice[:8]}_{m}'
        dur = dsp.encode(stereo, base)
        print(f'{m}: {dur:.1f}s → {base}.mp3 ({"cache" if r.cached else "rendered"}, {r.billed_chars} chars)')
    return 0


def _audition_stage(args, provider) -> int:
    """Render one stage of a script on every model in --models, using the script's voice and settings."""
    from .script import parse_script
    from .assemble import build_segments, Segment
    from .providers import RenderRequest
    from . import dsp
    import numpy as np
    s = parse_script(Path(args.script).read_text())
    st = next((x for x in s.stages if x.name == args.stage), None)
    if not st: print(f'no stage {args.stage}'); return 1
    models = args.models.split(',')
    voice = args.voice or s.voice
    for m in models:
        st.model = m
        plan = build_segments(s, st, MAX_CHARS.get(m, 4000))
        audio = np.zeros(0, dtype=np.float32); billed = 0
        for i, p in enumerate(plan):
            if isinstance(p, Segment):
                r = provider.render(RenderRequest(text=p.text, voice=voice, model=m, settings=s.stage_settings(st), seed=s.seed + i))
                seg, _ = dsp.trim_edges(r.audio); billed += r.billed_chars
                audio = np.concatenate([audio, seg, dsp.silence(0.35)])
            elif hasattr(p, 'seconds'):
                audio = np.concatenate([audio, dsp.silence(min(p.seconds, 2.0))])
        base = AUDITIONS / f'{s.id}_{st.name}_{m}'
        dur = dsp.encode(dsp.to_stereo(audio, 0), base)
        print(f'{m}: {dur:.1f}s → {base}.mp3 ({billed} chars billed)')
    return 0


def cmd_fx(args) -> int:
    """Print resolved per-stage FX (script + overrides) and the field metadata as JSON."""
    from .script import parse_script, FX_FIELDS
    script_path = Path(args.script)
    s = parse_script(script_path.read_text())
    op = overrides_path(script_path)
    ov = json.loads(op.read_text()) if op.exists() else {}
    out = {'fields': [{'key': k, 'min': lo, 'max': hi, 'step': st, 'label': lb} for (k, _a, lo, hi, st, lb) in FX_FIELDS], 'stages': {}}
    for st in s.stages:
        fx = s.stage_fx(st)
        base = {k: getattr(fx, a) for (k, a, *_r) in FX_FIELDS}
        over = (ov.get('fx') or {}).get(st.name, {})
        out['stages'][st.name] = {'script': base, 'override': over}
    print(json.dumps(out))
    return 0


def cmd_voices(args) -> int:
    from .providers import ElevenLabs
    load_env()
    el = ElevenLabs(os.environ['ELEVENLABS_API_KEY'])
    for v in el.voices():
        labels = v.get('labels') or {}
        print(f"{v['voice_id']}  {v['name']:<40} {v.get('category','')}  {labels.get('gender','')} {labels.get('accent','')} {labels.get('description','')}")
    return 0


def cmd_account(args) -> int:
    from .providers import ElevenLabs
    load_env()
    el = ElevenLabs(os.environ['ELEVENLABS_API_KEY'])
    d = el.subscription()
    print(json.dumps({k: d.get(k) for k in ('tier', 'status', 'character_count', 'character_limit', 'next_character_count_reset_unix')}, indent=1))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog='hpyno_pipeline')
    sub = p.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('validate'); a.add_argument('script'); a.set_defaults(fn=cmd_validate)
    a = sub.add_parser('estimate'); a.add_argument('script'); a.set_defaults(fn=cmd_estimate)
    a = sub.add_parser('assemble', help='re-emit the package from cached renders + overrides (free)'); a.add_argument('script')
    a.add_argument('--no-bed', action='store_true'); a.add_argument('--out'); a.add_argument('--stage', default=None)
    a.set_defaults(fn=lambda args: cmd_render(argparse.Namespace(**{**vars(args), 'provider': 'cache-only'})))
    a = sub.add_parser('render'); a.add_argument('script'); a.add_argument('--provider', default='elevenlabs', choices=['elevenlabs', 'mock', 'cache-only'])
    a.add_argument('--stage'); a.add_argument('--no-bed', action='store_true'); a.add_argument('--out', help='write package under this dir instead of public/sessions')
    a.set_defaults(fn=cmd_render)
    a = sub.add_parser('audition'); a.add_argument('--voice'); a.add_argument('--text'); a.add_argument('--models', default='eleven_v3,eleven_multilingual_v2')
    a.add_argument('--script', help='render a whole stage of this script instead of --text'); a.add_argument('--stage')
    a.add_argument('--settings', help='e.g. "stability=0.4 style=0.2 speed=0.9"'); a.set_defaults(fn=cmd_audition)
    a = sub.add_parser('fx'); a.add_argument('script'); a.set_defaults(fn=cmd_fx)
    a = sub.add_parser('voices'); a.set_defaults(fn=cmd_voices)
    a = sub.add_parser('account'); a.set_defaults(fn=cmd_account)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == '__main__':
    sys.exit(main())
