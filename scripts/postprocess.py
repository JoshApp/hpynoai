#!/usr/bin/env python3
"""
HPYNO Audio Post-Processor

Takes raw continuous stage audio and enhances it for hypnosis:
  - Insert/extend pauses between sentences
  - Time-stretch deep stages (slow delivery without pitch change)
  - Emphasis stretch on marked command words
  - Reverb tail on pauses (voice echoes into silence)
  - Whisper sublayer for deep stages
  - Volume boost on embedded commands
  - Re-transcribe final audio for accurate timestamps

Requires: ffmpeg, librosa, soundfile, scipy, numpy
Install:  pip install librosa soundfile scipy numpy

Usage:
  from postprocess import postprocess_stage
  result = postprocess_stage(audio_path, whisper_words, slices, opts)
"""

import os
import tempfile
import subprocess
import numpy as np

try:
    import librosa
    import soundfile as sf
    HAS_LIBROSA = True
except ImportError:
    HAS_LIBROSA = False
    print("Warning: librosa/soundfile not installed — time-stretch disabled")
    print("  pip install librosa soundfile")

try:
    import pyrubberband as pyrb
    # Verify the CLI is actually available
    import shutil
    HAS_RUBBERBAND = shutil.which('rubberband') is not None
    if not HAS_RUBBERBAND:
        print("Note: pyrubberband installed but rubberband-cli not found — using librosa stretcher")
        print("  For better quality: sudo apt install rubberband-cli")
except ImportError:
    HAS_RUBBERBAND = False

try:
    from scipy.signal import fftconvolve
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False


# ── Defaults (can be overridden per stage) ──

DEFAULT_OPTS = {
    # Pause insertion
    "min_sentence_pause": 1.5,     # minimum gap between sentences (seconds)
    "max_sentence_pause": 4.0,     # maximum gap
    "pause_scale": 1.0,            # multiplier (deeper stages → higher)

    # Time stretch
    "speed": 1.0,                  # 0.85 = 15% slower (1.0 = no change)

    # Emphasis
    "cmd_stretch": 1.0,            # off — rubberband on short words causes artifacts
    "cmd_volume_boost_db": 1.5,    # dB boost for command words

    # Effects
    "reverb_wet": 0.0,             # reverb mix during pauses (0-1, 0=off)
    "reverb_decay": 1.5,           # reverb tail length (seconds)
    "reverb_full": 0.0,            # full reverb on speech itself (0-1, cathedral effect)
    "whisper_layer": False,         # add pitched-down whisper sublayer
    "whisper_volume": 0.15,         # whisper layer volume
    "whisper_semitones": -3,        # pitch shift for whisper

    # Output
    "normalize": True,
    "target_lufs": -18,
}


def postprocess_stage(audio_path, whisper_words, slices, opts=None, cmd_words=None):
    """
    Post-process a single stage's audio.

    Args:
        audio_path: path to raw WAV file
        whisper_words: list of {word, start, end} from Whisper
        slices: list of slice text strings
        opts: override dict (merged with DEFAULT_OPTS)
        cmd_words: set of word indices in whisper_words that are [CMD] marked

    Returns:
        {
            "audio_path": path to processed WAV,
            "whisper_words": updated word timestamps (after edits),
            "duration": new duration in seconds,
        }
    """
    o = {**DEFAULT_OPTS, **(opts or {})}
    cmd_words = cmd_words or set()

    # Effect metadata for debug visualization
    effects = {
        "speed": o["speed"],
        "time_stretch": [],     # [{"start", "end"}] — regions that were stretched
        "pauses_inserted": [],  # [{"at", "added"}] — where silence was added
        "cmd_words": [],        # [{"start", "end", "word"}] — emphasized words
        "reverb_regions": [],   # [{"start", "end", "wet"}] — where reverb is active
        "whisper_layer": False,
    }

    if not HAS_LIBROSA:
        return _fallback_process(audio_path, whisper_words, slices, o)

    # Load audio
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    original_dur = len(y) / sr

    # ── Step 1: Time-stretch (global) ──
    if o["speed"] != 1.0 and 0.7 <= o["speed"] <= 1.0:
        y = _time_stretch(y, sr, o["speed"])
        scale = 1.0 / o["speed"]
        for w in whisper_words:
            w["start"] *= scale
            w["end"] *= scale
        effects["time_stretch"].append({"start": 0, "end": round(len(y)/sr, 3)})
        print(f"    stretch: {o['speed']:.0%} speed ({original_dur:.1f}s → {len(y)/sr:.1f}s)")

    # ── Step 2: Find sentence boundaries (gaps in whisper) ──
    gaps = _find_gaps(whisper_words)

    # ── Step 3: Insert/extend pauses at gaps ──
    if o["min_sentence_pause"] > 0 and gaps:
        y, whisper_words, pause_info = _insert_pauses(y, sr, whisper_words, gaps, o)
        effects["pauses_inserted"] = pause_info
        print(f"    pauses: {len(gaps)} gaps processed ({len(y)/sr:.1f}s)")

    # ── Step 4: Emphasis stretch on command words ──
    if cmd_words and o["cmd_stretch"] != 1.0:
        y, whisper_words = _stretch_words(y, sr, whisper_words, cmd_words, o["cmd_stretch"])
        print(f"    emphasis: {len(cmd_words)} words stretched")

    # Track CMD word positions (after all time edits)
    for wi in cmd_words:
        if wi < len(whisper_words):
            w = whisper_words[wi]
            effects["cmd_words"].append({"start": round(w["start"], 3), "end": round(w["end"], 3), "word": w["word"]})

    # ── Step 5: Volume boost on command words ──
    if cmd_words and o["cmd_volume_boost_db"] > 0:
        y = _boost_words(y, sr, whisper_words, cmd_words, o["cmd_volume_boost_db"])

    # ── Step 6: Reverb ──
    if HAS_SCIPY:
        if o["reverb_full"] > 0:
            # Full reverb (cathedral) — replaces tail reverb, applies to everything
            y = _add_full_reverb(y, sr, o)
            print(f"    full reverb: {o['reverb_full']:.0%}")
        elif o["reverb_wet"] > 0:
            # Tail reverb only — blooms at phrase endings into silence
            y, reverb_regions = _add_reverb_tails(y, sr, whisper_words, o)
            effects["reverb_regions"] = reverb_regions
            print(f"    reverb tails: wet={o['reverb_wet']:.0%}, decay={o['reverb_decay']:.1f}s")

    # ── Step 7: Whisper sublayer ──
    effects["whisper_layer"] = bool(o["whisper_layer"])
    if o["whisper_layer"] and HAS_LIBROSA:
        y = _add_whisper_layer(y, sr, whisper_words, o)
        print(f"    whisper layer: {o['whisper_semitones']}st, vol={o['whisper_volume']:.0%}")

    # ── Step 8: Normalize ──
    if o["normalize"]:
        peak = np.max(np.abs(y))
        if peak > 0:
            y = y / peak * 0.95  # leave headroom

    # ── Write output ──
    out_path = audio_path.replace(".wav", "_processed.wav")
    sf.write(out_path, y, sr)

    return {
        "audio_path": out_path,
        "whisper_words": whisper_words,
        "duration": len(y) / sr,
        "effects": effects,
    }


# ══════════════════════════════════════════════════════════════════════
# INTERNALS
# ══════════════════════════════════════════════════════════════════════

def _time_stretch(y, sr, rate):
    """Time-stretch audio. Uses Rubberband (high quality speech) if available,
    falls back to librosa phase vocoder."""
    if HAS_RUBBERBAND:
        # Rubberband: rate < 1 = slower. It expects time_stretch_ratio, not speed.
        # pyrubberband.time_stretch(y, sr, rate) where rate=0.9 means 90% speed (slower)
        return pyrb.time_stretch(y, sr, rate)
    else:
        return librosa.effects.time_stretch(y, rate=rate)


def _find_gaps(words, min_gap=0.3):
    """Find silence gaps between words that likely correspond to sentence/phrase boundaries."""
    gaps = []
    for i in range(1, len(words)):
        gap = words[i]["start"] - words[i-1]["end"]
        if gap >= min_gap:
            gaps.append({
                "after_word_idx": i - 1,
                "gap_start": words[i-1]["end"],
                "gap_end": words[i]["start"],
                "original_gap": gap,
            })
    return gaps


def _insert_pauses(y, sr, words, gaps, opts):
    """Insert or extend silence at sentence boundaries.

    Works in reverse order so sample indices stay valid.
    Crossfades with existing audio at splice points to avoid clicks.
    """
    min_pause = opts["min_sentence_pause"]
    max_pause = opts["max_sentence_pause"]
    scale = opts["pause_scale"]
    xfade_ms = 30  # crossfade duration in ms
    xfade_samples = int(xfade_ms / 1000 * sr)

    pause_info = []

    for gap in reversed(gaps):
        current_gap = gap["original_gap"]
        desired = min(max_pause, max(min_pause, current_gap * scale * 1.5))

        if desired <= current_gap:
            continue  # already long enough

        add_secs = desired - current_gap
        add_samples = int(add_secs * sr)

        # Splice point: middle of the existing gap (in original sample space)
        gap_mid = (gap["gap_start"] + gap["gap_end"]) / 2
        splice_at = int(gap_mid * sr)
        splice_at = max(xfade_samples, min(splice_at, len(y) - xfade_samples))

        # Pure silence
        fill = np.zeros(add_samples)

        # Fade out audio into silence at start of fill
        fade_out = np.linspace(1, 0, xfade_samples)
        fade_in = np.linspace(0, 1, xfade_samples)

        before_region = y[splice_at - xfade_samples:splice_at].copy()
        fill[:xfade_samples] = before_region * fade_out

        # Build the tail: fade the continuing audio back in from silence
        tail_start = splice_at + xfade_samples
        tail_end = min(tail_start + xfade_samples, len(y))
        tail_len = tail_end - tail_start
        tail = y[tail_start:tail_end].copy()

        # Fade the end of fill into the tail
        if tail_len > 0:
            fi = np.linspace(0, 1, tail_len)
            fill[-tail_len:] = 0  # ensure silence
            # The tail itself gets faded in
            tail *= fi

        y = np.concatenate([
            y[:splice_at - xfade_samples],
            fill,
            tail,
            y[tail_end:],
        ])

        # Track where we inserted (will be corrected to final time below)
        pause_info.append({"at": round(gap_mid, 3), "added": round(add_secs, 3)})

        # Shift word timestamps after this gap
        for w in words:
            if w["start"] > gap_mid:
                w["start"] += add_secs
                w["end"] += add_secs

    # Correct pause positions to final timeline (they were recorded in pre-shift time)
    # Since we processed in reverse, earlier pauses need cumulative shift from later ones
    pause_info.reverse()  # now in chronological order
    cumulative = 0.0
    for p in pause_info:
        p["at"] = round(p["at"] + cumulative, 3)
        cumulative += p["added"]

    return y, words, pause_info


def _stretch_words(y, sr, words, word_indices, factor):
    """Time-stretch specific words by a factor (e.g., 1.2 = 20% longer)."""
    # Process in reverse so indices stay valid
    sorted_indices = sorted(word_indices, reverse=True)
    total_shift = 0.0

    for wi in sorted_indices:
        if wi >= len(words):
            continue
        w = words[wi]
        start_s = int(w["start"] * sr)
        end_s = int(w["end"] * sr)
        if end_s <= start_s or (end_s - start_s) < sr * 0.4:
            continue  # skip words shorter than 400ms — rubberband artifacts on short segments

        segment = y[start_s:end_s].copy()
        stretched = _time_stretch(segment, sr, 1.0/factor)
        added = (len(stretched) - len(segment)) / sr

        # Crossfade at splice boundaries (50ms) to avoid hard transition
        xf = min(int(0.05 * sr), len(segment) // 4, len(stretched) // 4)
        if xf > 1:
            ramp = np.linspace(0, 1, xf)
            # Fade in: blend from original start into stretched start
            stretched[:xf] = y[start_s:start_s+xf] * (1 - ramp) + stretched[:xf] * ramp
            # Fade out: blend from stretched end into original continuation
            if end_s + xf <= len(y):
                stretched[-xf:] = stretched[-xf:] * (1 - ramp) + y[end_s:end_s+xf] * ramp

        y = np.concatenate([y[:start_s], stretched, y[end_s:]])

        # Update this word's end time
        w["end"] += added

        # Shift all subsequent words
        for j in range(wi + 1, len(words)):
            words[j]["start"] += added
            words[j]["end"] += added

        total_shift += added

    return y, words


def _boost_words(y, sr, words, word_indices, db):
    """Apply volume boost to CMD words, grouping consecutive indices
    into single regions to avoid overlapping envelopes."""
    gain = 10 ** (db / 20)

    # Group consecutive indices into regions
    sorted_idx = sorted(word_indices)
    regions = []  # [(start_sample, end_sample)]
    i = 0
    while i < len(sorted_idx):
        wi_start = sorted_idx[i]
        wi_end = sorted_idx[i]
        # Extend region while indices are consecutive
        while i + 1 < len(sorted_idx) and sorted_idx[i + 1] <= wi_end + 1:
            i += 1
            wi_end = sorted_idx[i]
        i += 1

        if wi_start >= len(words) or wi_end >= len(words):
            continue
        start_s = int(words[wi_start]["start"] * sr)
        end_s = int(words[wi_end]["end"] * sr)
        if end_s > start_s and end_s <= len(y):
            regions.append((start_s, end_s))

    # Apply one smooth envelope per region — single continuous curve, no flat section
    for start_s, end_s in regions:
        seg_len = end_s - start_s
        # Full-length smooth hump: rises to gain at center, falls back to 1 at edges
        t = np.linspace(0, np.pi, seg_len)
        envelope = 1 + (gain - 1) * np.sin(t)  # sine hump: 1 → gain → 1
        y[start_s:end_s] *= envelope

    return y


def _add_reverb_tails(y, sr, words, opts):
    """Add reverb that blooms naturally at the end of each phrase.

    Triggers at phrase boundaries (not between every word).
    Uses a deterministic IR built from decaying sine components for
    consistent, warm character across runs.
    """
    wet = opts["reverb_wet"]
    decay_time = opts["reverb_decay"]

    # ── Deterministic impulse response (seeded noise × exponential decay) ──
    # Fixed seed = same reverb character every run
    ir_len = int(decay_time * 0.8 * sr)  # ~1.2s IR
    rng = np.random.RandomState(42)
    ir = rng.randn(ir_len) * np.exp(-np.linspace(0, 8, ir_len))  # faster decay
    ir = ir / np.max(np.abs(ir)) * 0.25

    # Convolve full signal with reverb
    reverbed = fftconvolve(y, ir)[:len(y)]

    # ── Find phrase boundaries (not just word gaps) ──
    # A phrase boundary = gap > 0.4s OR a gap that's significantly longer
    # than the average inter-word gap in its neighborhood
    phrase_ends = []  # list of (word_end_sample, next_start_sample)
    if len(words) > 1:
        # Compute all gaps
        all_gaps = []
        for i in range(len(words) - 1):
            g = words[i + 1]["start"] - words[i]["end"]
            all_gaps.append(g)

        # Median gap = typical inter-word spacing
        median_gap = sorted(all_gaps)[len(all_gaps) // 2] if all_gaps else 0.2

        for i in range(len(words) - 1):
            gap_sec = all_gaps[i]
            # Trigger reverb if gap is either:
            # - longer than 0.4s absolute, OR
            # - more than 2x the median gap (relatively long pause)
            # Skip first phrase boundary — reverb at the very start sounds wrong
            if gap_sec > 0.4 or (gap_sec > 0.15 and gap_sec > median_gap * 2):
                word_end = int(words[i]["end"] * sr)
                next_start = int(words[i + 1]["start"] * sr)
                phrase_ends.append((word_end, next_start))

        # Skip the first phrase boundary — reverb right at stage start sounds wrong
        if phrase_ends:
            phrase_ends = phrase_ends[1:]

        # Also add the very last word → end of audio
        if words:
            last_end = int(words[-1]["end"] * sr)
            if last_end < len(y) - int(0.3 * sr):
                phrase_ends.append((last_end, len(y)))

    # ── Build envelope ──
    envelope = np.zeros(len(y))
    reverb_regions = []
    ramp_up = int(1.2 * sr)      # 1.2s gradual fade-in through end of phrase
    decay_samples = int(decay_time * sr)

    for word_end, next_start in phrase_ends:
        if word_end >= len(y):
            continue

        # Ramp up: last 200ms of phrase → smooth quadratic rise to peak
        ramp_start = max(0, word_end - ramp_up)
        ramp_len = word_end - ramp_start
        if ramp_len > 0:
            t_ramp = np.linspace(0, 1, ramp_len)
            ramp_vals = t_ramp * t_ramp * t_ramp  # cubic ease-in — stays subtle, peaks late
            region = slice(ramp_start, word_end)
            envelope[region] = np.maximum(envelope[region], ramp_vals)

        # Decay: exponential fall into the pause
        available = min(decay_samples, next_start - word_end, len(y) - word_end)
        if available > 0:
            t_decay = np.arange(available)
            decay_vals = np.exp(-3.0 * t_decay / decay_samples)
            region = slice(word_end, word_end + available)
            envelope[region] = np.maximum(envelope[region], decay_vals)

        reverb_regions.append({
            "start": round(ramp_start / sr, 3),
            "end": round(min(word_end + available, len(y)) / sr, 3),
            "wet": wet,
        })

    # Apply: reverb * envelope * wet
    out = y + reverbed * envelope * wet

    return out, reverb_regions


def _add_full_reverb(y, sr, opts):
    """Apply reverb to the entire signal — voice sounds like it's in a large space.
    Unlike tail reverb, this affects speech directly (cathedral/void effect)."""
    wet = opts["reverb_full"]

    # Short IR (0.8s) with fast decay — spacious but not echoey
    ir_len = int(0.8 * sr)
    rng = np.random.RandomState(77)
    ir = rng.randn(ir_len) * np.exp(-np.linspace(0, 8, ir_len))  # fast decay
    ir = ir / np.max(np.abs(ir)) * 0.15

    reverbed = fftconvolve(y, ir)[:len(y)]

    # Wet/dry mix
    y = y * (1 - wet * 0.3) + reverbed * wet

    return y


def _add_whisper_layer(y, sr, words, opts):
    """Add a warm, muffled copy underneath the voice for depth.

    No pitch shift (avoids robotic/alien artifacts). Instead:
    - Heavy lowpass filter (~800Hz) to keep only the warm body of the voice
    - Slight delay (30ms) so it sits behind the dry voice
    - Smooth speech mask so it only plays during words
    """
    volume = opts["whisper_volume"]

    from scipy.signal import butter, sosfilt

    # Heavy lowpass at 250Hz — only the deep chest resonance comes through
    sos = butter(3, 250, btype='low', fs=sr, output='sos')
    warm = sosfilt(sos, y)

    # Bass boost: amplify the sub-200Hz range for more chest thump
    sos_bass = butter(2, 200, btype='low', fs=sr, output='sos')
    bass = sosfilt(sos_bass, y)
    warm = warm + bass * 0.5

    # 60ms delay — enough separation to not comb-filter with the dry voice
    delay_samples = int(0.06 * sr)
    warm = np.concatenate([np.zeros(delay_samples), warm[:-delay_samples]])

    # Speech mask — only during words, with 200ms fade on edges
    mask = np.zeros(len(y))
    for w in words:
        s = int(w["start"] * sr)
        e = int(w["end"] * sr)
        mask[s:min(e, len(y))] = 1.0

    from scipy.ndimage import uniform_filter1d
    mask = uniform_filter1d(mask.astype(float), int(0.2 * sr))

    y = y + warm[:len(y)] * mask * volume

    return y


def _fallback_process(audio_path, whisper_words, slices, opts):
    """Fallback when librosa is not available — use ffmpeg for basic pause insertion."""
    gaps = _find_gaps(whisper_words)
    if not gaps or opts["min_sentence_pause"] <= 0:
        return {
            "audio_path": audio_path,
            "whisper_words": whisper_words,
            "duration": whisper_words[-1]["end"] if whisper_words else 0,
        }

    # Build ffmpeg filter chain to insert silences
    # This is limited compared to librosa but works without dependencies
    out_path = audio_path.replace(".wav", "_processed.wav")

    # For now, just copy — the full pipeline needs librosa
    import shutil
    shutil.copy2(audio_path, out_path)
    print("    (fallback: no post-processing, install librosa for full pipeline)")

    return {
        "audio_path": out_path,
        "whisper_words": whisper_words,
        "duration": whisper_words[-1]["end"] if whisper_words else 0,
    }


# ══════════════════════════════════════════════════════════════════════
# STAGE PRESETS — graduated intensity for each session stage
# ══════════════════════════════════════════════════════════════════════

STAGE_PRESETS = {
    "settle": {
        "speed": 1.0,
        "min_sentence_pause": 1.2,
        "pause_scale": 1.0,
        "reverb_wet": 0.0,
        "whisper_layer": False,
    },
    "induction": {
        "speed": 0.95,
        "min_sentence_pause": 1.5,
        "pause_scale": 1.2,
        "reverb_wet": 0.1,
        "whisper_layer": False,
    },
    "deepening": {
        "speed": 0.92,
        "min_sentence_pause": 2.0,
        "pause_scale": 1.5,
        "reverb_wet": 0.15,
        "whisper_layer": False,
    },
    "trance": {
        "speed": 0.88,
        "min_sentence_pause": 2.5,
        "pause_scale": 1.8,
        "reverb_wet": 0.2,
        "whisper_layer": True,
        "whisper_volume": 0.12,
    },
    "deep": {
        "speed": 0.85,
        "min_sentence_pause": 3.0,
        "pause_scale": 2.0,
        "reverb_wet": 0.25,
        "whisper_layer": True,
        "whisper_volume": 0.18,
    },
    "emergence": {
        "speed": 0.95,
        "min_sentence_pause": 1.5,
        "pause_scale": 1.0,
        "reverb_wet": 0.1,
        "whisper_layer": False,
    },
}


def get_stage_opts(stage_name):
    """Get post-processing options for a stage, falling back to defaults."""
    preset = STAGE_PRESETS.get(stage_name, {})
    return {**DEFAULT_OPTS, **preset}
