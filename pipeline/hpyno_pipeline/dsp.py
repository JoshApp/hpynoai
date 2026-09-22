"""Audio polish on the assembled stage: emphasis, whispered doubles, proximity, drift, reverb, loudness."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from typing import Callable
from scipy.signal import butter, sosfilt

from .providers import SR


def db(x: float) -> float:
    return float(10 ** (x / 20))


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(round(seconds * SR)), dtype=np.float32)


def trim_edges(audio: np.ndarray, thresh_db: float = -56.0, keep: float = 0.15, fade: float = 0.12) -> tuple[np.ndarray, float]:
    """Trim leading/trailing near-silence, keeping `keep` seconds and fading the cut edges
    (raised cosine) so a trailing breath never ends in a click. Returns (audio, seconds trimmed from the start)."""
    if audio.size == 0: return audio, 0.0
    env = np.abs(audio)
    thr = db(thresh_db)
    idx = np.where(env > thr)[0]
    if idx.size == 0: return audio, 0.0
    a = max(0, idx[0] - int(keep * SR)); b = min(audio.size, idx[-1] + int(keep * SR))
    y = audio[a:b].copy()
    n = min(int(fade * SR), y.size // 3)
    if n > 0:
        ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))
        y[:n] *= ramp; y[-n:] *= ramp[::-1]
    return y, a / SR


def first_onset(audio: np.ndarray, thresh_db: float = -34.0) -> float | None:
    """Seconds until the signal first exceeds thresh_db (speech onset), or None."""
    idx = np.where(np.abs(audio) > db(thresh_db))[0]
    return float(idx[0] / SR) if idx.size else None


def refine_word_bounds(audio: np.ndarray, start: float, end: float, floor_db: float = -40.0, rel: float = 0.12) -> tuple[float, float]:
    """Snap a word's [start, end] to where energy actually is inside that span.
    The API attributes pauses to the *next* character, so starts drift early."""
    a, b = int(max(0, start) * SR), int(min(audio.size / SR, end) * SR)
    if b - a < int(0.02 * SR): return start, end
    env = np.abs(audio[a:b])
    # smooth with a short window so a single click doesn't count
    w = max(1, int(0.006 * SR))
    env = np.convolve(env, np.ones(w) / w, mode='same')
    thr = max(db(floor_db), env.max() * rel)
    idx = np.where(env > thr)[0]
    if idx.size == 0: return start, end
    ns, ne = a + idx[0], a + idx[-1] + 1
    new_start = ns / SR - 0.015
    new_end = max(new_start + 0.05, ne / SR + 0.02)
    return max(start, new_start), min(end, new_end) if new_end < end else end


def fade_span(audio: np.ndarray, start: float, end: float, to_db: float) -> None:
    """In place: the span sinks linearly in dB from 0 to to_db, holding to_db to the end."""
    a, b = max(0, int(start * SR)), min(audio.size, int(end * SR))
    if b <= a: return
    g = 10 ** (np.linspace(0, to_db, b - a) / 20)
    audio[a:b] *= g.astype(np.float32)


def boost_span(audio: np.ndarray, start: float, end: float, gain_db: float, ramp: float = 0.03) -> None:
    """In place: raise a time span by gain_db with short ramps."""
    a, b = int(start * SR), int(end * SR)
    a = max(0, a); b = min(audio.size, b)
    if b <= a: return
    r = min(int(ramp * SR), (b - a) // 2)
    env = np.ones(b - a, dtype=np.float32)
    if r > 0:
        env[:r] = np.linspace(0, 1, r); env[-r:] = np.linspace(1, 0, r)
    audio[a:b] *= (1 + (db(gain_db) - 1) * env)


def mix_at(base: np.ndarray, layer: np.ndarray, at: float, gain_db: float) -> np.ndarray:
    a = int(at * SR)
    need = a + layer.size
    if need > base.size:
        base = np.concatenate([base, np.zeros(need - base.size, dtype=np.float32)])
    base[a:need] += layer * db(gain_db)
    return base


def lowpass(audio: np.ndarray, hz: float) -> np.ndarray:
    return sosfilt(butter(2, hz, btype='low', fs=SR, output='sos'), audio).astype(np.float32)


def apply_edits(audio: np.ndarray, edits: list[tuple[float, float, np.ndarray]]) -> tuple[np.ndarray, 'Callable[[float], float]']:
    """Replace [start,end) spans with new audio (any length). Returns the new audio and a
    function mapping old times to new times (monotonic, exact at edit boundaries)."""
    edits = sorted(edits, key=lambda e: e[0])
    pieces: list[np.ndarray] = []
    # (old_time, delta) breakpoints after each edit
    bps: list[tuple[float, float]] = []
    cur = 0; delta = 0.0
    xf = int(0.012 * SR)
    for start, end, new in edits:
        a, b = int(start * SR), int(end * SR)
        a = max(cur, a); b = max(a, b)
        head = audio[cur:a].copy()
        new = new.copy()
        if new.size == 0 or np.max(np.abs(new)) < 1e-6:
            # silence insert: soften both sides the old way — lowpassed fade-out into the fill,
            # de-breathed fade-in out of it
            new = soft_fill(head, new, audio, b)
        else:
            # replacement (e.g. stretched span): short equal-power crossfades at both ends
            n = min(xf, head.size, new.size)
            if n > 0:
                r = np.linspace(0, 1, n, dtype=np.float32)
                new[:n] = new[:n] * r + head[-n:] * (1 - r); head = head[:-n]
            tail = audio[b:b + xf]
            m = min(xf, new.size, tail.size)
            if m > 0:
                r = np.linspace(0, 1, m, dtype=np.float32)
                new[-m:] = new[-m:] * (1 - r) + tail[:m] * r
                b += m
        pieces.append(head); pieces.append(new)
        d_old = (b - a) / SR; d_new = new.size / SR
        bps.append((start, delta))                 # up to start: shift by delta
        delta += d_new - d_old
        bps.append((end, delta))                   # from end on: new delta (inside span: scaled)
        cur = b
    pieces.append(audio[cur:])
    out = np.concatenate(pieces) if pieces else audio
    # de-breath the resume after every silence insert
    pos = 0
    for i, pc in enumerate(pieces):
        pos += pc.size
        if i % 2 == 1 and (pc.size == 0 or np.max(np.abs(pc)) < 1e-6):
            soften_resume(out, pos)

    def remap(t: float) -> float:
        d = 0.0
        for i in range(0, len(bps), 2):
            s0, d0 = bps[i]; e0, d1 = bps[i + 1]
            if t <= s0: return t + d
            if t < e0:
                frac = (t - s0) / (e0 - s0) if e0 > s0 else 1.0
                return s0 + d0 + frac * ((e0 + d1) - (s0 + d0))
            d = d1
        return t + d
    return out, remap


def soft_fill(head: np.ndarray, fill: np.ndarray, audio: np.ndarray, resume_at: int) -> np.ndarray:
    """Old-pipeline splice: the 40 ms before the cut fades out through a lowpass into the fill;
    the 200 ms after the cut fades in from a heavy lowpass (mutes breath hiss). Mutates `head`
    in place for its fade-out; returns the fill with the fade-in tail *prepended to the resume*
    handled by the caller via `audio` (we return only the fill, edges pre-shaped)."""
    xo = min(int(0.04 * SR), head.size)
    if xo > 0:
        seg = head[-xo:]
        seg = lowpass(seg, 900) if seg.size > 8 else seg
        head[-xo:] = seg * np.exp(-np.linspace(0, 6, xo)).astype(np.float32)
    return fill


def soften_resume(audio: np.ndarray, at: int, ms: float = 0.2) -> None:
    """De-breath the first `ms` seconds after a splice in place: heavy lowpass blending to dry."""
    n = min(int(ms * SR), audio.size - at)
    if n <= 8: return
    seg = audio[at:at + n]
    lp = lowpass(seg, 1500)
    blend = (np.linspace(0, 1, n, dtype=np.float32)) ** 2
    ramp = np.ones(n, dtype=np.float32); f = min(n, int(0.04 * SR)); ramp[:f] = np.linspace(0, 1, f) ** 2
    audio[at:at + n] = (lp * (1 - blend) + seg * blend) * ramp


def echoes(phrase: np.ndarray, first_db: float, gap: float, repeats: int = 3) -> list[tuple[np.ndarray, float, float]]:
    """(audio, offset_from_phrase_END_seconds, pan) for decaying repeats; each darker, quieter,
    further out. Repeats are spaced by `gap` *after the previous one ends*, so they never pile
    up on the original or on each other."""
    out = []
    plen = phrase.size / SR
    for k in range(repeats):
        g = db(first_db - 5 * k)
        y = lowpass(phrase, 5200 / (k + 1)) * g
        fade = min(y.size // 2, int(0.12 * SR)); fin = min(y.size // 2, int(0.02 * SR))
        if fade > 0: y[-fade:] *= np.linspace(1, 0, fade)
        if fin > 0: y[:fin] *= np.linspace(0, 1, fin)
        start_after_end = gap + k * (plen + gap)
        out.append((y, start_after_end, (0.35 + 0.2 * k) * (1 if k % 2 == 0 else -1)))
    return out


def mix_stereo_at(base: np.ndarray, layer: np.ndarray, at: float, gain_db: float, pan: float) -> np.ndarray:
    """Mix a mono layer into a stereo buffer with constant-power pan (-1..1)."""
    a = int(at * SR); need = a + layer.size
    if need > base.shape[0]:
        base = np.concatenate([base, np.zeros((need - base.shape[0], 2), dtype=np.float32)])
    p = (pan + 1) / 2 * np.pi / 2
    base[a:need, 0] += layer * db(gain_db) * np.cos(p)
    base[a:need, 1] += layer * db(gain_db) * np.sin(p)
    return base


def stretch(audio: np.ndarray, factor: float, semitones: float) -> np.ndarray:
    """Slow down by `factor` (1.06 = 6% longer) and/or shift pitch, formant-preserving."""
    if abs(factor - 1) < 1e-3 and abs(semitones) < 1e-3: return audio
    import pyrubberband as prb
    y = audio.astype(np.float64)
    if abs(factor - 1) >= 1e-3: y = prb.time_stretch(y, SR, 1 / factor)
    if abs(semitones) >= 1e-3: y = prb.pitch_shift(y, SR, semitones)
    return y.astype(np.float32)


def proximity(audio: np.ndarray, amount: float) -> np.ndarray:
    """Close-mic feel: low-shelf warmth only (no high loss — air is what makes a whisper feel close)."""
    if amount <= 0: return audio
    lo = sosfilt(butter(2, 200, btype='low', fs=SR, output='sos'), audio)
    return (audio + lo * 0.45 * amount).astype(np.float32)


def to_stereo(audio: np.ndarray, drift: float, period: float = 23.0) -> np.ndarray:
    """Mono → stereo with an optional slow pan drift (constant power)."""
    n = audio.size
    if drift <= 0:
        return np.stack([audio, audio], axis=1)
    t = np.arange(n) / SR
    pan = np.sin(2 * np.pi * t / period) * drift * 0.5  # -0.5..0.5 * drift
    l = np.cos((pan + 0.5) * np.pi / 2) * audio
    r = np.sin((pan + 0.5) * np.pi / 2) * audio
    return np.stack([l, r], axis=1).astype(np.float32)


def _measure_loudness(path: Path) -> dict | None:
    import json, re
    p = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(path), '-af', 'loudnorm=I=-18:TP=-1.5:LRA=13:print_format=json', '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'\{[^{}]*"input_i"[^{}]*\}', p.stderr, re.S)
    return json.loads(m.group(0)) if m else None


def ffmpeg_polish(stereo: np.ndarray, reverb: float, ir: Path | None, target_lufs: float = -18.0,
                  send: np.ndarray | None = None, tails: float = 0.0, denoise_db: float = 6.0, bright: float = 0.4,
                  level_db: float = 0.0) -> np.ndarray:
    """Convolution reverb (constant wet mix + optional phrase-end 'tails' send), a slow light
    compressor, and measured two-pass loudness normalisation (linear gain, no pumping)."""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / 'in.wav'; mid = Path(td) / 'mid.wav'; out = Path(td) / 'out.wav'
        sf.write(src, stereo, SR, subtype='FLOAT')
        # Voice chain: clean the lows, tame mud, de-ess, open presence and air, then a slow leveler.
        dn = f'adeclick=w=55:o=75:t=2,afftdn=nr={denoise_db:.1f}:nf=-50:tn=1:om=o:rf=-35,' if denoise_db > 0 else ''
        voice_eq = (f'{dn}highpass=f=65:poles=2,'
                    'equalizer=f=280:t=q:w=1.2:g=-2,'
                    'deesser=i=0.18:m=0.5:f=0.5,'
                    f'equalizer=f=3200:t=q:w=1.0:g={1.0 + 1.5 * bright:.2f},'
                    f'highshelf=f=9000:g={3.0 * bright:.2f},'
                    f'aexciter=level_in=1:level_out=1:amount={0.7 * bright:.2f}:drive=3:blend=0:freq=8000:ceil=15000')
        # Two-stage dynamics: slow leveler for the arc, fast light catcher for peaks
        comp = ('acompressor=threshold=-26dB:ratio=1.8:attack=60:release=600:knee=8,'
                'acompressor=threshold=-12dB:ratio=4:attack=2:release=80:knee=3')
        inputs = ['-i', str(src)]
        use_ir = ir is not None and ir.exists() and (reverb > 0 or (tails > 0 and send is not None))
        if use_ir:
            inputs += ['-i', str(ir)]
            # Reverb: pre-delay so reflections land after the consonant, dark + no mud on the return,
            # and DUCKED by the dry voice so the room only blooms when she stops.
            parts = [f'[0:a]{voice_eq},asplit=3[dry][w][key];'
                     f'[w]adelay=32|32,aformat=channel_layouts=stereo[wd];[wd][1:a]afir=dry=0:wet=10,'
                     f'highpass=f=200,lowpass=f=6500[wetraw];'
                     f'[wetraw][key]sidechaincompress=threshold=-32dB:ratio=6:attack=4:release=380:makeup=1[wet]']
            mix_in = '[dry][wet]'; weights = f'1 {reverb:.3f}'; n = 2
            if tails > 0 and send is not None:
                snd = Path(td) / 'send.wav'; sf.write(snd, send, SR, subtype='FLOAT'); inputs += ['-i', str(snd)]
                parts.append('[2:a][1:a]afir=dry=0:wet=10,highpass=f=200,lowpass=f=7000,aformat=channel_layouts=stereo[tail]')
                mix_in += '[tail]'; weights += f' {tails:.3f}'; n = 3
            fc = ';'.join(parts) + f';{mix_in}amix=inputs={n}:weights={weights}:normalize=0,{comp}[o]'
            cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-filter_complex', fc, '-map', '[o]', '-ar', str(SR), str(mid)]
        else:
            cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *inputs, '-af', f'{voice_eq},{comp}', '-ar', str(SR), str(mid)]
        subprocess.run(cmd, check=True)
        m = _measure_loudness(mid)
        if m:
            ln = (f"loudnorm=I={target_lufs}:TP=-1.5:LRA=13:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
                  f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
        else:
            ln = f'loudnorm=I={target_lufs}:TP=-1.5:LRA=13'
        if abs(level_db) > 0.01: ln += f',volume={level_db:.2f}dB'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(mid), '-af', ln, '-ar', str(SR), str(out)], check=True)
        y, sr = sf.read(out, dtype='float32')
    if y.ndim == 1: y = np.stack([y, y], axis=1)
    return y


def encode(stereo: np.ndarray, out_base: Path) -> float:
    """Write Opus + MP3, return duration in seconds."""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / 'in.wav'
        sf.write(src, stereo, SR, subtype='PCM_16')
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(src), '-c:a', 'libopus', '-b:a', '112k', '-vbr', 'on', str(out_base) + '.webm'], check=True)
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(src), '-c:a', 'libmp3lame', '-b:a', '192k', str(out_base) + '.mp3'], check=True)
    return stereo.shape[0] / SR


def probe_duration(path: Path) -> float:
    out = subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)])
    return float(out.decode().strip())
