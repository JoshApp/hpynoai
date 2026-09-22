"""
Ambient bed rendered from the session's depth curve and breath cues.

Layers: binaural pair (carrier L, carrier+beat(t) R, beat follows depth),
sub drone with slow LFO, a fifth, brown-noise wind, and a breath-noise layer
whose envelope follows the stage breath patterns so listen mode still
"breathes with you".
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt

from .providers import SR
from .dsp import encode, db


def _piecewise(t: np.ndarray, knots: list[tuple[float, float]]) -> np.ndarray:
    xs = np.array([k[0] for k in knots]); ys = np.array([k[1] for k in knots])
    return np.interp(t, xs, ys)


def _breath_env(t: np.ndarray, patterns: list[tuple[float, tuple[float, float, float, float]]]) -> np.ndarray:
    """0..1 envelope following (start, (inhale, holdIn, exhale, holdOut)) per stage."""
    env = np.zeros_like(t)
    for i, (start, pat) in enumerate(patterns):
        end = patterns[i + 1][0] if i + 1 < len(patterns) else t[-1] + 1
        m = (t >= start) & (t < end)
        cyc = sum(pat)
        if cyc <= 0: continue
        local = (t[m] - start) % cyc
        inh, hi, exh, ho = pat
        v = np.where(local < inh, 0.5 - 0.5 * np.cos(np.pi * local / max(inh, 1e-3)),
            np.where(local < inh + hi, 1.0,
            np.where(local < inh + hi + exh, 0.5 + 0.5 * np.cos(np.pi * (local - inh - hi) / max(exh, 1e-3)), 0.0)))
        env[m] = v
    return env


def _pad(t: np.ndarray, depth: np.ndarray, root_hz: float, seed: int = 11) -> np.ndarray:
    """Slow chord pad: minor progression on the root, 3 detuned voices per note, crossfaded every ~26 s,
    low-passed brighter as depth rises then darker at the very bottom."""
    rng = np.random.default_rng(seed)
    # degrees in semitones for i, VI, III, VII (natural minor), voiced as triads
    chords = [[0, 3, 7, 12], [8, 12, 15, 20], [3, 7, 10, 15], [10, 14, 17, 22]]
    order = [0, 1, 2, 3, 0, 2, 1, 3]
    seg = 26.0
    n = t.size
    out = np.zeros(n, dtype=np.float32)
    total = t[-1]
    k = 0; start = 0.0
    while start < total:
        chord = chords[order[k % len(order)]]
        a = int(start * SR); b = min(n, int((start + seg) * SR))
        tt = t[a:b]
        y = np.zeros(b - a, dtype=np.float32)
        for semi in chord:
            f = root_hz * 2 ** (semi / 12) * (2 if semi < 6 else 1)  # keep it in a mid register
            for det in (-0.3, 0.0, 0.3):
                ff = f * 2 ** (det / 1200 * 8)
                ph = rng.uniform(0, 2 * np.pi)
                y += (np.sin(2 * np.pi * ff * tt + ph) + 0.35 * np.sin(2 * np.pi * 2 * ff * tt + ph)) / 12
        # crossfade window
        env = np.ones(b - a, dtype=np.float32)
        xf = min(b - a, int(6 * SR))
        if xf > 0: env[:xf] *= np.linspace(0, 1, xf); env[-xf:] *= np.linspace(1, 0, xf)
        out[a:b] += y * env
        start += seg - 6.0; k += 1
    bright = sosfilt(butter(2, 900, btype='low', fs=SR, output='sos'), out)
    dark = sosfilt(butter(2, 260, btype='low', fs=SR, output='sos'), out)
    open_amt = np.clip(depth * 1.4, 0, 1) * (1 - np.clip((depth - 0.8) * 4, 0, 1))
    return (dark * (1 - open_amt) + bright * open_amt).astype(np.float32) * 0.5


def render_bed(out_dir: Path, length: float, depth_knots: list[tuple[float, float]],
               breath_patterns: list[tuple[float, tuple[float, float, float, float]]],
               carrier: float = 110.0, beat: tuple[float, float] = (7.0, 3.0), drone: float = 55.0,
               wind: float = 0.3, breath_noise: float = 0.25, pad_level: float = 0.16,
               speech: list[tuple[float, float]] | None = None, duck: float = 0.35) -> float:
    n = int(length * SR)
    t = np.arange(n) / SR
    depth = np.clip(_piecewise(t, depth_knots), 0, 1)
    # binaural: beat frequency follows depth (hi at 0 → lo at 1); phase-integrate for a clean chirp
    beat_hz = beat[0] + (beat[1] - beat[0]) * depth
    phase_r = 2 * np.pi * np.cumsum(carrier + beat_hz) / SR
    left = 0.20 * np.sin(2 * np.pi * carrier * t)
    right = 0.20 * np.sin(phase_r)
    # drone + fifth with slow LFOs
    dr = 0.13 * (0.72 + 0.28 * np.sin(2 * np.pi * t / 20)) * np.sin(2 * np.pi * drone * t)
    fi = 0.05 * (0.6 + 0.4 * np.sin(2 * np.pi * t / 30)) * np.sin(2 * np.pi * drone * 1.5 * t)
    # wind: brown noise, low-passed, gently modulated
    rng = np.random.default_rng(7)
    white = rng.standard_normal(n).astype(np.float32)
    brown = np.cumsum(white); brown -= np.mean(brown); brown /= (np.max(np.abs(brown)) + 1e-9)
    wind_sig = sosfilt(butter(2, 260, btype='low', fs=SR, output='sos'), brown) * wind * (0.7 + 0.3 * np.sin(2 * np.pi * t / 12))
    # breath noise: band-passed white noise, envelope from breath pattern
    breath = sosfilt(butter(2, [700, 1800], btype='band', fs=SR, output='sos'), white) * 0.06
    env = _breath_env(t, breath_patterns) if breath_patterns else np.zeros_like(t)
    breath_sig = breath * env * breath_noise * (0.4 + 0.6 * depth)
    pad = _pad(t, depth, carrier / 2)
    mono = dr + fi + wind_sig + breath_sig + pad * pad_level
    l = left + mono; r = right + mono
    # duck under the voice: activity from word spans, smoothed (fast in, slow out), then a gain dip
    if speech and duck > 0:
        act = np.zeros(n, dtype=np.float32)
        for a, b in speech:
            i0, i1 = max(0, int((a - 0.05) * SR)), min(n, int((b + 0.25) * SR))
            if i1 > i0: act[i0:i1] = 1.0
        # asymmetric smoothing: attack ~80 ms, release ~900 ms
        env = np.zeros(n, dtype=np.float32); v = 0.0
        ka = 1 - np.exp(-1 / (0.08 * SR)); kr = 1 - np.exp(-1 / (0.9 * SR))
        step = 64
        for i in range(0, n, step):
            target = act[i]
            v += (target - v) * (ka if target > v else kr) * step
            env[i:i + step] = max(0.0, min(1.0, v))
        gain = 1.0 - duck * env
        l *= gain; r *= gain
    # fade in/out
    fade = int(3 * SR)
    ramp = np.linspace(0, 1, fade)
    for ch in (l, r):
        ch[:fade] *= ramp; ch[-fade:] *= ramp[::-1]
    stereo = np.stack([l, r], axis=1).astype(np.float32)
    peak = np.max(np.abs(stereo)) + 1e-9
    stereo *= min(1.0, db(-3) / peak)
    return encode(stereo, out_dir / 'bed')
