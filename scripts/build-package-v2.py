#!/usr/bin/env python3
"""
Build schema-v2 session packages from the legacy per-stage audio in content-src/.

  python3 scripts/build-package-v2.py surrender
  python3 scripts/build-package-v2.py relax

Seed of the Phase-2 pipeline: assembles contiguous stage files (voice +
gate question + silent window + response), encodes Opus + MP3, flattens
word timings to stage-relative seconds, and writes session.v2.json.
"""
import json, os, subprocess, sys, tempfile, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB = os.path.join(ROOT, 'public')
SCRATCH = os.environ.get('HPYNO_SCRATCH', tempfile.gettempdir())

def ffprobe_duration(path):
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])
    return float(out.decode().strip())

def encode(wav, out_base):
    subprocess.check_call(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '64k', '-vbr', 'on', out_base + '.webm'])
    subprocess.check_call(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '128k', out_base + '.mp3'])
    return ffprobe_duration(out_base + '.webm')

def concat(parts, out_wav):
    """parts: list of ('file', path) | ('silence', seconds). Produces 48k stereo wav."""
    inputs, filters, labels = [], [], []
    for i, (kind, val) in enumerate(parts):
        if kind == 'file':
            inputs += ['-i', val]
            filters.append(f'[{len(inputs)//2 - 1}:a]aformat=sample_rates=48000:channel_layouts=stereo[p{i}]')
        else:
            filters.append(f'anullsrc=r=48000:cl=stereo,atrim=0:{val}[p{i}]')
        labels.append(f'[p{i}]')
    fc = ';'.join(filters) + ';' + ''.join(labels) + f'concat=n={len(parts)}:v=0:a=1[out]'
    subprocess.check_call(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-filter_complex', fc, '-map', '[out]', out_wav])

def words_of(line, offset):
    ls = line.get('startTime', 0.0)
    return [{'w': w['word'], 's': round(offset + ls + w['start'], 3), 'e': round(offset + ls + w['end'], 3)} for w in line.get('words', [])]

def line_of(line, offset):
    ls = line.get('startTime', 0.0)
    le = line.get('endTime', ls + line.get('duration', 0))
    return {'start': round(offset + ls, 3), 'end': round(offset + le, 3), 'text': line['text'], 'words': words_of(line, offset)}

def clip_line(clip, offset):
    words = [{'w': w['w'], 's': round(offset + w['s'], 3), 'e': round(offset + w['e'], 3)} for w in clip['words']]
    return {'start': round(offset, 3), 'end': round(offset + clip['duration'], 3), 'text': clip['text'], 'words': words}

TRIGGER_WORDS = {
    'drop': ('drop', 'sink', 'sinking', 'fall', 'falling', 'let go', 'go.'),
    'bloom': ('pleasure', 'mine', 'yes', 'ecstasy', 'release'),
    'snap': ('now', 'obey'),
}

MIN_TRIGGER_GAP = 8.0  # seconds between triggers so pulses never overlap

def pick_triggers(stage_lines, stage_start, max_per_stage=2):
    out, seen, last_t = [], 0, -1e9
    for line in stage_lines:
        for w in line['words']:
            lw = w['w'].lower().strip('.,!?…')
            for kind, keys in TRIGGER_WORDS.items():
                t = stage_start + w['s']
                if lw in keys and seen < max_per_stage and t - last_t >= MIN_TRIGGER_GAP:
                    out.append({'t': round(t, 3), 'type': 'trigger', 'kind': kind})
                    seen += 1; last_t = t
                    break
    return out

def render_bed(out_dir, carrier=110.0, beat_from=7.0, beat_to=3.0, sweep_sec=400.0, length=600.0, drone=55.0, level=1.0):
    """Binaural bed: left = carrier, right = carrier + beat(t) as a true chirp
    (phase-integrated), plus a slow drone, a fifth, and low wind. Opus + MP3."""
    k = (beat_from - beat_to) / sweep_sec            # Hz per second
    f0 = carrier + beat_from
    # phase/(2*pi): integral of f(t)  = f0*t - k*t^2/2 while sweeping, then constant f1 with continuity
    f1 = carrier + beat_to
    c = (f0 * sweep_sec - k * sweep_sec ** 2 / 2) - f1 * sweep_sec
    right = f"sin(2*PI*(if(lt(t,{sweep_sec}), {f0}*t - {k/2}*t*t, {f1}*t + {c})))"
    b = 0.22 * level
    fc = (
        f"[0]volume={b}[l];"
        f"[1]volume={b}[r];"
        f"[l][r]join=inputs=2:channel_layout=stereo[bin];"
        f"[2]volume='0.13*(0.72+0.28*sin(2*PI*t/20))':eval=frame,aformat=channel_layouts=stereo[drone];"
        f"[3]volume='0.05*(0.6+0.4*sin(2*PI*t/30))':eval=frame,aformat=channel_layouts=stereo[fifth];"
        f"[4]lowpass=f=260,volume='0.32*(0.7+0.3*sin(2*PI*t/12))':eval=frame,aformat=channel_layouts=stereo[wind];"
        f"[bin][drone][fifth][wind]amix=inputs=4:normalize=0,alimiter=limit=0.9"
    )
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', f'sine=frequency={carrier}:duration={length}:sample_rate=48000',
            '-f', 'lavfi', '-i', f"aevalsrc='{right}':s=48000:d={length}",
            '-f', 'lavfi', '-i', f'sine=frequency={drone}:duration={length}:sample_rate=48000',
            '-f', 'lavfi', '-i', f'sine=frequency={drone*1.5}:duration={length}:sample_rate=48000',
            '-f', 'lavfi', '-i', f'anoisesrc=color=brown:duration={length}:sample_rate=48000:amplitude=0.5:seed=7',
            '-filter_complex', fc]
    subprocess.check_call(args + ['-c:a', 'libopus', '-b:a', '80k', os.path.join(out_dir, 'bed.webm')])
    subprocess.check_call(args + ['-c:a', 'libmp3lame', '-b:a', '128k', os.path.join(out_dir, 'bed.mp3')])
    print(f'bed: {carrier}Hz carrier, beat {beat_from}→{beat_to}Hz over {sweep_sec}s')

def build_surrender():
    src = os.path.join(ROOT, 'content-src', 'audio', 'surrender')
    man = json.load(open(os.path.join(src, 'manifest.json')))
    clips = json.load(open(os.path.join(SCRATCH, 'clip-transcripts.json')))
    out_dir = os.path.join(PUB, 'sessions', 'surrender')
    os.makedirs(out_dir, exist_ok=True)
    stages_by = {s['name']: s for s in man['stages']}
    f = lambda n: os.path.join(src, n + '.mp3')
    render_bed(out_dir, carrier=110.0, beat_from=7.0, beat_to=3.0, sweep_sec=380.0, drone=55.0)
    GATE_WINDOW = 7.0
    BREATH_DUR = 24.0

    plan = [
        # name, parts, text-lines builder, cue builder
        ('settling', [('file', f('breath_intro')), ('silence', 1.0), ('file', f('breath_instructions')), ('silence', BREATH_DUR), ('file', f('breath_good')), ('silence', 2.0)]),
        # next stage opens with "good, you said yes" — no separate response clip here
        ('invitation', [('file', f('00_invitation')), ('silence', 0.8), ('file', f('gate_invitation_0')), ('silence', GATE_WINDOW), ('silence', 0.8)]),
        ('surrender', [('file', f('01_surrender')), ('silence', 0.8), ('file', f('gate_surrender_0')), ('silence', GATE_WINDOW), ('file', f('sinking')), ('silence', 1.5)]),
        ('devotion', [('file', f('02_devotion')), ('silence', 0.5), ('file', f('responsive')), ('silence', 2.0)]),
        ('ecstasy', [('file', f('03_ecstasy')), ('silence', 2.0)]),
        ('afterglow', [('file', f('04_afterglow')), ('silence', 3.0)]),
    ]

    pkg_stages, text_stages, cues = [], [], []
    t_abs = 0.0
    patterns = {
        'settling': {'inhale': 4, 'holdIn': 0, 'exhale': 4, 'holdOut': 0},
        'invitation': {'inhale': 4, 'holdIn': 1, 'exhale': 3, 'holdOut': 0},
        'surrender': {'inhale': 4, 'holdIn': 2, 'exhale': 3, 'holdOut': 0},
        'devotion': {'inhale': 4, 'holdIn': 3, 'exhale': 3, 'holdOut': 0},
        'ecstasy': {'inhale': 4, 'holdIn': 4, 'exhale': 4, 'holdOut': 0},
        'afterglow': {'inhale': 4, 'holdIn': 0, 'exhale': 4, 'holdOut': 0},
    }
    depth = {'settling': 0.15, 'invitation': 0.3, 'surrender': 0.5, 'devotion': 0.75, 'ecstasy': 1.0, 'afterglow': 0.35}
    anchor = {'settling': 'settle', 'invitation': 'breathe', 'surrender': 'pendulum', 'devotion': 'breathe', 'ecstasy': 'speak', 'afterglow': 'settle'}

    for idx, (name, parts) in enumerate(plan):
        wav = os.path.join(SCRATCH, f'surrender_{name}.wav')
        concat(parts, wav)
        dur = encode(wav, os.path.join(out_dir, f'{idx:02d}_{name}'))
        stage_start = t_abs
        lines = []
        # walk parts to compute offsets
        off = 0.0
        for kind, val in parts:
            if kind == 'silence':
                off += val
                continue
            base = os.path.basename(val)[:-4]
            if base in stages_by or base[3:] in stages_by:
                m = stages_by.get(base) or stages_by[base[3:]]
                for ln in m['lines']:
                    lines.append(line_of(ln, off))
                off += m['duration']
            else:
                c = clips[base]
                lines.append(clip_line(c, off))
                if base.startswith('gate_') and not base.startswith('gate_response'):
                    cues.append({'t': round(stage_start + off + c['duration'] + 0.3, 3), 'type': 'gate', 'window': GATE_WINDOW - 0.6, 'prompt': c['text'].rstrip('.').lower()})
                if base == 'breath_instructions':
                    cues.append({'t': round(stage_start + off + c['duration'] + 0.5, 3), 'type': 'breath', 'dur': BREATH_DUR - 1.0, 'pattern': patterns['settling'], 'guided': True})
                off += c['duration']
        cues.append({'t': round(stage_start, 3), 'type': 'intensity', 'value': depth[name], 'ramp': 0 if idx == 0 else 12})
        cues.append({'t': round(stage_start, 3), 'type': 'pattern', 'pattern': patterns[name]})
        cues.append({'t': round(stage_start, 3), 'type': 'anchor', 'mode': anchor[name]})
        if name in ('surrender', 'devotion', 'ecstasy'):
            cues += pick_triggers(lines, stage_start)
        pkg_stages.append({'name': name, 'file': f'{idx:02d}_{name}.webm', 'fileMp3': f'{idx:02d}_{name}.mp3', 'duration': round(dur, 3)})
        text_stages.append({'name': name, 'lines': lines})
        t_abs += dur

    cues.sort(key=lambda c: c['t'])
    pkg = {
        'schema': 2, 'id': 'surrender', 'title': 'Surrender',
        'subtitle': 'An intimate descent into letting go.',
        'description': 'Soft dominance and permissive suggestion. You are invited, never pushed. Two moments ask for your yes.',
        'durationSec': round(t_abs, 1), 'rating': 'adult', 'tags': ['submission', 'devotion', 'trance'], 'intensity': 3,
        'theme': {'colors': {'c1': [0.48, 0.08, 0.20], 'c2': [0.36, 0.06, 0.24], 'c3': [0.76, 0.34, 0.42], 'c4': [0.03, 0.012, 0.03]}, 'wisp': [0.98, 0.5, 0.6], 'shape': 1.0},
        'audio': {'bed': {'file': 'bed.webm', 'fileMp3': 'bed.mp3', 'loop': True, 'gainDb': -4}, 'stages': pkg_stages},
        'cues': cues,
        'text': {'stages': text_stages},
    }
    json.dump(pkg, open(os.path.join(out_dir, 'session.v2.json'), 'w'), indent=1, ensure_ascii=False)
    print(f'surrender: {len(pkg_stages)} stages, {t_abs:.1f}s, {len(cues)} cues')
    return pkg

def build_relax():
    src = os.path.join(ROOT, 'content-src', 'relax')
    man = json.load(open(os.path.join(src, 'manifest.json')))
    out_dir = os.path.join(PUB, 'sessions', 'relax')
    os.makedirs(out_dir, exist_ok=True)
    pkg_stages, text_stages, cues = [], [], []
    t_abs = 0.0
    depth = {'settle': 0.15, 'induction': 0.3, 'deepening': 0.55, 'post_gate': 0.6, 'trance': 0.8, 'deep': 0.95, 'emergence': 0.3}
    for idx, s in enumerate(man['stages']):
        base = os.path.basename(s['file'])[:-4]
        interlude = float(s.get('interlude') or 0)
        wav = os.path.join(SCRATCH, f'relax_{base}.wav')
        concat([('file', os.path.join(src, base + '.mp3')), ('silence', interlude + 0.5)], wav)
        dur = encode(wav, os.path.join(out_dir, f'v2_{base}'))
        lines = [line_of(ln, 0.0) for ln in s['lines']]
        cues.append({'t': round(t_abs, 3), 'type': 'intensity', 'value': depth.get(s['name'], 0.5), 'ramp': 0 if idx == 0 else 15})
        cues.append({'t': round(t_abs, 3), 'type': 'anchor', 'mode': 'breathe' if idx else 'settle'})
        cmd = (s.get('effects') or {}).get('cmd_words') or []
        last_t = -1e9
        for w in cmd:
            t = t_abs + w['start']
            if t - last_t < MIN_TRIGGER_GAP: continue
            cues.append({'t': round(t, 3), 'type': 'trigger', 'kind': 'bloom'})
            last_t = t
            if sum(1 for c in cues if c['type'] == 'trigger' and c['t'] >= t_abs) >= 2: break
        pkg_stages.append({'name': s['name'], 'file': f'v2_{base}.webm', 'fileMp3': f'v2_{base}.mp3', 'duration': round(dur, 3)})
        text_stages.append({'name': s['name'], 'lines': lines})
        t_abs += dur
    cues.sort(key=lambda c: c['t'])
    render_bed(out_dir, carrier=120.0, beat_from=10.0, beat_to=4.0, sweep_sec=600.0, drone=60.0)
    pkg = {
        'schema': 2, 'id': 'relax', 'title': 'Deep Relax', 'subtitle': 'A slow descent into stillness.',
        'durationSec': round(t_abs, 1), 'rating': 'all', 'tags': ['relaxation'], 'intensity': 2,
        'theme': {'colors': {'c1': [0.3, 0.18, 0.55], 'c2': [0.2, 0.22, 0.5], 'c3': [0.5, 0.4, 0.7], 'c4': [0.02, 0.015, 0.06]}, 'wisp': [0.6, 0.45, 0.95], 'shape': 0.3},
        'audio': {'bed': {'file': 'bed.webm', 'fileMp3': 'bed.mp3', 'loop': True, 'gainDb': -5}, 'stages': pkg_stages},
        'cues': cues, 'text': {'stages': text_stages},
    }
    json.dump(pkg, open(os.path.join(out_dir, 'session.v2.json'), 'w'), indent=1, ensure_ascii=False)
    print(f'relax: {len(pkg_stages)} stages, {t_abs:.1f}s, {len(cues)} cues')
    return pkg

def write_index(pkgs):
    idx = {'schema': 2, 'sessions': []}
    for p in pkgs:
        idx['sessions'].append({
            'id': p['id'], 'title': p['title'], 'subtitle': p.get('subtitle', ''), 'durationSec': p['durationSec'],
            'intensity': p['intensity'], 'rating': p['rating'], 'tags': p['tags'],
            'themePreview': {'c1': p['theme']['colors']['c1'], 'c2': p['theme']['colors']['c3']},
        })
    json.dump(idx, open(os.path.join(PUB, 'sessions.json'), 'w'), indent=2)
    print('index:', [s['id'] for s in idx['sessions']])

if __name__ == '__main__':
    which = sys.argv[1:] or ['surrender', 'relax']
    built = []
    if 'surrender' in which: built.append(build_surrender())
    if 'relax' in which: built.append(build_relax())
    # index always lists every existing v2 package, surrender first
    all_pkgs = []
    for sid in ['surrender', 'relax']:
        p = os.path.join(PUB, 'sessions', sid, 'session.v2.json')
        if os.path.exists(p): all_pkgs.append(json.load(open(p)))
    write_index(all_pkgs)
