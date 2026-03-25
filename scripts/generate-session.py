#!/usr/bin/env python3
"""
HPYNO Voice Pipeline

Full workflow: script.txt → generate audio → transcribe → slice → manifest → session config

Usage:
  python3 scripts/generate-session.py scripts/surrender-v2.txt
  python3 scripts/generate-session.py scripts/surrender-v2.txt --skip-generate  # re-slice only
  python3 scripts/generate-session.py scripts/surrender-v2.txt --config-only    # just rebuild config

Requires: ffmpeg, openai-whisper
"""

import json, sys, os, re, wave, time, subprocess, urllib.request, argparse, shutil

API_URL = "https://sexyvoice.ai/api/v1/speech"

# Load .env file if present
_env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
if os.path.exists(_env_path):
    with open(_env_path) as _ef:
        for _line in _ef:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                _k, _v = _line.split('=', 1)
                os.environ.setdefault(_k.strip(), _v.strip().strip("'\""))

API_KEY = os.environ.get("SEXYVOICE_API_KEY", "")
DEFAULT_STYLE = "very slow and deliberate, long pauses between phrases, hypnotic, soft dominance, breathy"
DEFAULT_VOICE = "zephyr"
MAX_CHARS = 950


# ── Script Parser ──

def parse_script(path):
    """Parse script.txt into stages with slices, gates, interaction markers, and commands.

    Supported markers:
      [STAGE: name]        — new continuous-audio stage
      [STYLE: description] — voice style for this stage (overrides default)
      [SPEED: 0.9]         — post-process speed for this stage
      [SLICE]              — text display boundary
      [PAUSE]              — insert ellipsis pause in audio
      [PAUSE 3]            — insert longer pause (3s target in post-processing)
      [CMD text here]      — embedded command (gets emphasis in playback)
      [GATE]               — tag previous slice as gate prompt
      [GATE: text]         — separate gate prompt
      [BREATH-SYNC]        — start breathing interaction
      [INTERLUDE N]        — N seconds of silence after this stage (ambient takes over)
      [INTERACTIVE: type name] — standalone interactive clip (separate audio)
    """
    stages = []
    interactives = []  # [{ 'id': name, 'type': type, 'text': text }]
    current = None
    current_interactive = None  # accumulates text for interactive block

    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue

            # Interactive block — standalone clip
            m = re.match(r'\[INTERACTIVE:\s*(\S+)\s+(\S+)\]', line)
            if m:
                if current:
                    _flush(current)
                    stages.append(current)
                    current = None
                if current_interactive:
                    current_interactive['text'] = current_interactive['_buf'].strip()
                    del current_interactive['_buf']
                    interactives.append(current_interactive)
                current_interactive = {
                    'type': m.group(1).strip(),
                    'id': m.group(2).strip(),
                    '_buf': '',
                }
                continue

            # If we're in an interactive block, accumulate text
            if current_interactive:
                # Any new block marker ends the interactive
                if line.startswith('[STAGE:') or line.startswith('[INTERACTIVE:'):
                    current_interactive['text'] = current_interactive['_buf'].strip()
                    del current_interactive['_buf']
                    interactives.append(current_interactive)
                    current_interactive = None
                    # Fall through to handle the [STAGE:] below
                else:
                    current_interactive['_buf'] += line + ' '
                    continue

            m = re.match(r'\[STAGE:\s*(.+?)\]', line)
            if m:
                if current:
                    _flush(current)
                    stages.append(current)
                current = {
                    'name': m.group(1).strip(),
                    'slices': [], 'gates': [], 'slice_types': [],
                    'cmds': [],
                    'style': None,
                    'speed': None,
                    'pauses': [],
                    'interlude': 0,
                    '_buf': '',
                }
                continue

            if not current:
                continue

            # Interlude — silence after this stage
            m = re.match(r'\[INTERLUDE\s+(\d+(?:\.\d+)?)\]', line)
            if m:
                current['interlude'] = float(m.group(1))
                continue

            # Per-stage style override
            m = re.match(r'\[STYLE:\s*(.+?)\]', line)
            if m:
                current['style'] = m.group(1).strip()
                continue

            # Per-stage speed override
            m = re.match(r'\[SPEED:\s*([\d.]+)\]', line)
            if m:
                current['speed'] = float(m.group(1))
                continue

            # Old-style [GATE: text] — separate gate (kept for backwards compat)
            m = re.match(r'\[GATE:\s*(.+?)\]', line)
            if m:
                current['gates'].append(m.group(1).strip())
                continue

            # Inline [GATE] — tags the PREVIOUS slice as a gate prompt
            if line == '[GATE]':
                _flush(current)
                if current['slices']:
                    idx = len(current['slices']) - 1
                    while len(current['slice_types']) <= idx:
                        current['slice_types'].append('narration')
                    current['slice_types'][idx] = 'gate'
                continue

            # Inline [BREATH-SYNC] — tags the previous slice as breath-sync trigger
            if line == '[BREATH-SYNC]':
                _flush(current)
                if current['slices']:
                    idx = len(current['slices']) - 1
                    while len(current['slice_types']) <= idx:
                        current['slice_types'].append('narration')
                    current['slice_types'][idx] = 'breath-sync'
                continue

            if line == '[SLICE]':
                _flush(current)
                continue

            # [PAUSE] or [PAUSE N] — insert pause (with optional target duration)
            m = re.match(r'\[PAUSE(?:\s+(\d+(?:\.\d+)?))?\]', line)
            if m:
                current['_buf'] += '... '
                if m.group(1):
                    _flush(current)
                    # Store desired pause duration after the current slice
                    idx = len(current['slices']) - 1
                    current['pauses'].append((idx, float(m.group(1))))
                continue

            # [CMD text] — embedded command (spoken normally, emphasized in playback)
            # Can appear standalone or inline: "the easier it becomes... [CMD to relax]"
            if '[CMD ' in line:
                # Extract all CMD markers from the line, keep surrounding text
                remaining = line
                while '[CMD ' in remaining:
                    before, _, after = remaining.partition('[CMD ')
                    cmd_text, _, after = after.partition(']')
                    cmd_text = cmd_text.strip()
                    if before.strip():
                        current['_buf'] += before.strip() + ' '
                    current['_buf'] += cmd_text + ' '
                    if cmd_text:
                        current['cmds'].append(cmd_text)
                    remaining = after
                if remaining.strip():
                    current['_buf'] += remaining.strip() + ' '
                continue

            current['_buf'] += line + ' '

    if current:
        _flush(current)
        stages.append(current)
    if current_interactive:
        current_interactive['text'] = current_interactive['_buf'].strip()
        del current_interactive['_buf']
        interactives.append(current_interactive)

    for s in stages:
        del s['_buf']
        s['slices'] = [re.sub(r'\s+', ' ', t).strip() for t in s['slices']]
        while len(s['slice_types']) < len(s['slices']):
            s['slice_types'].append('narration')
        s.setdefault('cmds', [])
        s.setdefault('pauses', [])
        s.setdefault('style', None)
        s.setdefault('speed', None)
        s.setdefault('interlude', 0)

    # Clean up interactive text
    for ix in interactives:
        ix['text'] = re.sub(r'\s+', ' ', ix['text']).strip()

    return stages, interactives


def _flush(stage):
    t = stage['_buf'].strip()
    if t:
        stage['slices'].append(t)
    stage['_buf'] = ''


# ── API ──

def generate_audio(text, voice, style, seed=None):
    payload = {"model": "gpro", "voice": voice, "input": text, "style": style, "response_format": "wav"}
    if seed is not None:
        payload["seed"] = seed

    data = json.dumps(payload).encode()
    req = urllib.request.Request(API_URL, data=data, headers={
        "Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"
    })

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                result = json.loads(resp.read())
                if result.get("url"):
                    return result["url"], result.get("credits_remaining", "?")
        except Exception as e:
            print(f"    retry {attempt+1}: {e}")
            time.sleep(2)
    return None, None


def download(url, path):
    subprocess.run(["curl", "-s", "-L", "-o", path, url], check=True, timeout=30)


def wav_duration(path):
    with wave.open(path, 'rb') as w:
        return w.getnframes() / float(w.getframerate())


# ── Transcription — WhisperX (forced alignment) > faster-whisper > whisper ──

_wx_model = None
_wx_align_model = None
_wx_align_meta = None
_fw_model = None
_whisper_model = None

def transcribe(audio_path, model_size="base", known_text=None):
    """Transcribe with word-level timestamps.
    If known_text is provided, uses script-constrained alignment (most accurate).
    Priority: WhisperX (forced alignment) > faster-whisper > openai whisper."""

    # WhisperX — phoneme-level forced alignment (best precision)
    try:
        return _transcribe_whisperx(audio_path, model_size, known_text=known_text)
    except ImportError:
        pass
    except Exception as e:
        print(f"    whisperx failed ({e}), trying faster-whisper")

    # faster-whisper — fast, decent timestamps
    try:
        return _transcribe_faster_whisper(audio_path, model_size)
    except ImportError:
        pass
    except Exception as e:
        print(f"    faster-whisper failed ({e}), trying whisper")

    # openai whisper — fallback
    try:
        return _transcribe_whisper(audio_path, model_size)
    except ImportError:
        return None


def _transcribe_whisperx(audio_path, model_size="base", known_text=None):
    global _wx_model, _wx_align_model, _wx_align_meta
    import whisperx
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    audio = whisperx.load_audio(audio_path)

    if known_text:
        # Script-constrained alignment: skip transcription, align known text directly
        # Build a single segment with our known text
        segments = [{"text": known_text, "start": 0.0, "end": len(audio) / 16000}]
    else:
        # Normal: transcribe first, then align
        if _wx_model is None:
            _wx_model = whisperx.load_model(model_size, device, compute_type=compute_type)
        result = _wx_model.transcribe(audio, batch_size=16)
        segments = result["segments"]

    # Forced alignment — phoneme-level precision
    if _wx_align_model is None:
        _wx_align_model, _wx_align_meta = whisperx.load_align_model(
            language_code="en", device=device
        )
    result = whisperx.align(segments, _wx_align_model, _wx_align_meta, audio, device)

    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            if "start" in w and "end" in w:
                words.append({
                    "word": w["word"].strip(),
                    "start": round(w["start"], 3),
                    "end": round(w["end"], 3),
                })

    mode = "script-constrained" if known_text else "forced-aligned"
    if words:
        print(f"    [whisperx {mode}] {len(words)} words")
    return words if words else None


def _transcribe_faster_whisper(audio_path, model_size="base"):
    global _fw_model
    from faster_whisper import WhisperModel

    if _fw_model is None:
        _fw_model = WhisperModel(model_size, device="cpu", compute_type="int8")

    segments, _info = _fw_model.transcribe(audio_path, word_timestamps=True)

    words = []
    for seg in segments:
        for w in (seg.words or []):
            words.append({
                "word": w.word.strip(),
                "start": round(w.start, 3),
                "end": round(w.end, 3),
            })
    return words if words else None


def _transcribe_whisper(audio_path, model_size="base"):
    global _whisper_model
    import whisper

    if _whisper_model is None:
        _whisper_model = whisper.load_model(model_size)

    result = _whisper_model.transcribe(audio_path, word_timestamps=True)
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({"word": w["word"].strip(), "start": w["start"], "end": w["end"]})
    return words


# ── Slicing ──

def _clean_word(w):
    """Strip punctuation/ellipses for word matching — 'warmth...' → 'warmth'"""
    return re.sub(r'[.,!?]+$', '', w.replace('...', '').replace('…', '')).strip()

def _split_content_words(text):
    """Split text into content words, ignoring standalone '...' tokens."""
    return [w for w in text.split() if _clean_word(w)]

def find_cuts(words, slices):
    """Match slices to Whisper timestamps SEQUENTIALLY (1:1).
    Script text is truth, Whisper only provides timing.
    Walks through both lists in order — no proportional guessing."""
    if not words:
        return None

    # Build flat list of content words with their slice index
    content_words = []  # [(clean_word, display_word, slice_idx)]
    for si, slice_text in enumerate(slices):
        for w in slice_text.split():
            c = _clean_word(w)
            if c:
                content_words.append((c, w, si))

    # Walk through Whisper words and script content words together (1:1)
    word_timings = []
    wi = 0
    unspoken_slices = set()  # slices where Whisper had no words at all
    for _clean, display, si in content_words:
        if wi < len(words):
            word_timings.append({
                "word": display,
                "start": round(words[wi]["start"], 3),
                "end": round(words[wi]["end"], 3),
                "slice": si,
                "real": True,
            })
            wi += 1
        else:
            # Whisper ran out — this word wasn't spoken
            word_timings.append({
                "word": display,
                "start": 0, "end": 0,
                "slice": si,
                "real": False,
            })

    # Find slices where NO words had real timing (voice never said them)
    for si in range(len(slices)):
        slice_wt = [wt for wt in word_timings if wt["slice"] == si]
        if slice_wt and not any(wt["real"] for wt in slice_wt):
            unspoken_slices.add(si)
            print(f"    UNSPOKEN: '{slices[si][:50]}...' (not in audio)")

    # Group word timings by slice and compute cut points (skip unspoken)
    cuts = []
    for si, slice_text in enumerate(slices):
        if si in unspoken_slices:
            continue

        slice_words = [wt for wt in word_timings if wt["slice"] == si and wt["real"]]

        if slice_words:
            end_time = slice_words[-1]["end"]
            line_start = slice_words[0]["start"]
            # Adjust timestamps relative to line start
            adj_words = [{"word": w["word"],
                          "start": round(w["start"] - line_start, 3),
                          "end": round(w["end"] - line_start, 3)} for w in slice_words]
        else:
            end_time = cuts[-1]["end"] if cuts else 0
            line_start = end_time
            adj_words = []

        cuts.append({
            "index": si,
            "text": slice_text,
            "end": end_time,
            "startTime": line_start,
            "words": adj_words,
        })

    return cuts


def slice_audio(input_path, cuts, out_dir, stage_idx, stage_name):
    files = []
    prev = 0

    for ct in cuts:
        fname = f"{stage_idx:02d}_{stage_name}_{ct['index']:02d}.wav"
        out_path = os.path.join(out_dir, fname)

        start = prev  # no overlap — start exactly where previous ended
        end = ct["end"] + 0.1  # tiny tail for natural decay

        # Re-encode for sample-accurate cuts (-c copy can drift on WAV)
        subprocess.run(["ffmpeg", "-y", "-i", input_path, "-ss", str(start), "-to", str(end),
                        "-acodec", "pcm_s16le", out_path], capture_output=True, timeout=10)

        if os.path.exists(out_path) and os.path.getsize(out_path) > 100:
            dur = wav_duration(out_path)
            words = [{"word": w["word"], "start": round(max(0, w["start"] - start), 3),
                       "end": round(w["end"] - start, 3)} for w in ct.get("words", [])]
            entry = {"file": f"sessions/{os.path.basename(out_dir)}/{fname}", "text": ct["text"], "duration": round(dur, 2)}
            if words:
                entry["words"] = words
            files.append(entry)

        prev = ct["end"]

    return files


def slice_by_duration(input_path, slices, out_dir, stage_idx, stage_name):
    total = wav_duration(input_path)
    total_words = sum(len(s.split()) for s in slices)
    files = []
    t = 0

    for i, text in enumerate(slices):
        dur = (len(text.split()) / max(total_words, 1)) * total
        fname = f"{stage_idx:02d}_{stage_name}_{i:02d}.wav"
        out_path = os.path.join(out_dir, fname)
        start, end = max(0, t - 0.05), min(total, t + dur + 0.15)
        subprocess.run(["ffmpeg", "-y", "-i", input_path, "-ss", str(start), "-to", str(end),
                        "-c", "copy", out_path], capture_output=True, timeout=10)
        if os.path.exists(out_path) and os.path.getsize(out_path) > 100:
            files.append({"file": f"sessions/{os.path.basename(out_dir)}/{fname}", "text": text, "duration": round(wav_duration(out_path), 2)})
        t += dur

    return files


def _duration_based_lines(slices, total_dur):
    """Fallback: estimate line timing from word count ratios."""
    total_words = sum(len(s.split()) for s in slices)
    lines = []
    t = 0
    for text in slices:
        dur = (len(text.split()) / max(total_words, 1)) * total_dur
        lines.append({"text": text, "startTime": round(t, 3), "endTime": round(t + dur, 3), "duration": round(dur, 2)})
        t += dur
    return lines


# ── Config Generator ──

def generate_session_config(manifest, script_path, stages):
    """Generate TypeScript session config with texts matching manifest exactly."""
    session_id = manifest["session"]

    # Read the script for metadata comments
    config_lines = []
    config_lines.append("// Auto-generated texts from voice manifest — do not edit manually.")
    config_lines.append(f"// Regenerate with: python3 scripts/generate-session.py {script_path}")
    config_lines.append(f"// Session: {session_id}")
    config_lines.append("")
    config_lines.append("export const generatedTexts: Record<string, string[]> = {")

    for stage in manifest["stages"]:
        texts = [line["text"] for line in stage["lines"]]
        config_lines.append(f"  '{stage['name']}': [")
        for t in texts:
            escaped = t.replace("\\", "\\\\").replace("'", "\\'")
            config_lines.append(f"    '{escaped}',")
        config_lines.append("  ],")

    config_lines.append("};")

    # Export interaction markers per stage
    config_lines.append("")
    config_lines.append("// Interaction markers from script (gate, breath-sync, etc.)")
    config_lines.append("export const stageInteractions: Record<string, Array<{ index: number; type: string; text: string }>> = {")
    for stage in manifest["stages"]:
        markers = []
        for li, line in enumerate(stage["lines"]):
            if line.get("type"):
                markers.append({"index": li, "type": line["type"], "text": line["text"]})
        if markers:
            config_lines.append(f"  '{stage['name']}': [")
            for m in markers:
                escaped = m['text'].replace("\\", "\\\\").replace("'", "\\'")
                config_lines.append(f"    {{ index: {m['index']}, type: '{m['type']}', text: '{escaped}' }},")
            config_lines.append("  ],")
    config_lines.append("};")

    # Also export stage durations so the session config can use them
    config_lines.append("")
    config_lines.append("// Stage durations from audio (use these in session config)")
    config_lines.append("export const stageDurations: Record<string, number> = {")
    for stage in manifest["stages"]:
        dur = stage.get("duration", 0)
        # Add 5s buffer for interaction/transition time (interlude is separate)
        config_lines.append(f"  '{stage['name']}': {round(dur + 5)},")
    config_lines.append("};")

    # Export interludes
    config_lines.append("")
    config_lines.append("// Interludes — ambient-only silence after each stage (seconds)")
    config_lines.append("export const stageInterludes: Record<string, number> = {")
    for stage in manifest["stages"]:
        interlude = stage.get("interlude", 0)
        if interlude > 0:
            config_lines.append(f"  '{stage['name']}': {interlude},")
    config_lines.append("};")

    # Export interactive clips (standalone audio, not part of narration)
    config_lines.append("")
    config_lines.append("// Interactive clips — standalone audio files for interactions")
    config_lines.append("export const interactiveClips: Array<{ id: string; type: string; text: string; duration: number }> = [")
    for ix in manifest.get("interactive", []):
        escaped = ix['text'].replace("\\", "\\\\").replace("'", "\\'")
        config_lines.append(f"  {{ id: '{ix['id']}', type: '{ix.get('type', 'prompt')}', text: '{escaped}', duration: {ix.get('duration', 0)} }},")
    config_lines.append("];")

    out_path = os.path.join("src", "sessions", f"{session_id}-texts.ts")
    with open(out_path, "w") as f:
        f.write("\n".join(config_lines) + "\n")

    print(f"  Generated: {out_path}")
    return out_path


def generate_session_package(manifest, session_config, out_dir):
    """Generate session.json (full config for runtime loading) and update sessions.json index."""
    session_id = manifest["session"]

    # Build stages with texts from manifest merged with config
    stage_cfgs = session_config.get("stages", {})
    stages = []
    for ms in manifest["stages"]:
        sc = dict(stage_cfgs.get(ms["name"], {}))
        sc["name"] = ms["name"]
        sc["duration"] = ms["duration"]
        sc.setdefault("intensity", 0.5)
        sc.setdefault("textInterval", 9)
        sc.setdefault("breathCycle", 10)
        sc.setdefault("spiralSpeed", 0.7)
        sc["texts"] = [line["text"] for line in ms.get("lines", [])]
        if ms.get("interlude"):
            sc["interlude"] = ms["interlude"]
        # Remove pipeline-only keys
        for k in ("style", "speed", "pause_scale", "reverb_wet", "reverb_full", "whisper_layer", "whisper_volume"):
            sc.pop(k, None)
        stages.append(sc)

    # Build full session config
    config = {
        "id": session_id,
        "name": session_config.get("name", session_id.title()),
        "description": session_config.get("description", ""),
        "icon": session_config.get("icon", ""),
        "theme": session_config.get("theme", {}),
        "audio": session_config.get("audio", {}),
        "stages": stages,
        "photoWarning": session_config.get("photoWarning", True),
        "contentWarning": session_config.get("contentWarning", None),
    }

    # Write session.json
    session_json_path = os.path.join(out_dir, "session.json")
    with open(session_json_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  Generated: {session_json_path}")

    # Update sessions.json index
    index_path = os.path.join("public", "sessions.json")
    if os.path.exists(index_path):
        with open(index_path) as f:
            index = json.load(f)
    else:
        index = {"version": 1, "sessions": []}

    # Remove existing entry for this session
    index["sessions"] = [s for s in index["sessions"] if s["id"] != session_id]

    theme = config.get("theme", {})
    index["sessions"].append({
        "id": session_id,
        "name": config["name"],
        "description": config["description"],
        "icon": config.get("icon", ""),
        "contentWarning": config.get("contentWarning"),
        "photoWarning": config.get("photoWarning", False),
        "themePreview": {
            "primaryColor": theme.get("primaryColor", [0.5, 0.3, 0.8]),
            "secondaryColor": theme.get("secondaryColor", [0.3, 0.3, 0.7]),
            "accentColor": theme.get("accentColor", [0.6, 0.4, 1.0]),
            "bgColor": theme.get("bgColor", [0.03, 0.02, 0.08]),
            "particleColor": theme.get("particleColor", [0.5, 0.35, 0.9]),
            "textColor": theme.get("textColor", "#c8a0ff"),
            "textGlow": theme.get("textGlow", "rgba(200,160,255,0.4)"),
            "breatheColor": theme.get("breatheColor", "rgba(160,120,255,0.35)"),
        },
    })

    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)
    print(f"  Updated: {index_path}")


# ── Command Word Matching ──

def _find_cmd_word_indices(whisper_words, cmd_texts):
    """Find indices in whisper_words that correspond to [CMD] marked text.
    cmd_texts is a list of command phrases like ['go deeper', 'let go'].
    Returns a set of word indices."""
    indices = set()
    # Build list of clean whisper words for matching
    clean_whisper = [_clean_word(w["word"]).lower() for w in whisper_words]

    for cmd in cmd_texts:
        cmd_words = [_clean_word(w).lower() for w in cmd.split() if _clean_word(w)]
        if not cmd_words:
            continue
        # Slide window through whisper words looking for the sequence
        for i in range(len(clean_whisper) - len(cmd_words) + 1):
            if all(clean_whisper[i + j] == cmd_words[j] for j in range(len(cmd_words))):
                for j in range(len(cmd_words)):
                    indices.add(i + j)
                break  # first match only

    return indices


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description="HPYNO voice pipeline")
    parser.add_argument("script", help="Session script .txt")
    parser.add_argument("--config", help="Session config .json (auto-detected from script name if omitted)")
    parser.add_argument("--voice", default=None, help=f"Voice (default: from config or {DEFAULT_VOICE})")
    parser.add_argument("--style", default=None, help="Default style (overrides config)")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--whisper-model", default="base")
    parser.add_argument("--skip-generate", action="store_true", help="Skip API, use existing raw audio")
    parser.add_argument("--config-only", action="store_true", help="Only rebuild config from existing manifest")
    parser.add_argument("--no-postprocess", action="store_true", help="Skip audio post-processing")
    parser.add_argument("--reprocess", action="store_true", help="Reprocess existing audio with current script/config (no voice gen)")
    parser.add_argument("--stage", help="Only process this stage (by name)")
    parser.add_argument("--list-stages", action="store_true", help="List stages in the script and exit")
    args = parser.parse_args()

    # Import post-processor (optional — degrades gracefully)
    try:
        from postprocess import postprocess_stage, get_stage_opts
        HAS_POSTPROCESS = not args.no_postprocess
    except ImportError:
        HAS_POSTPROCESS = False
        if not args.no_postprocess:
            print("Note: postprocess.py not available (install librosa for full pipeline)")

    stages, interactives = parse_script(args.script)
    script_base = os.path.splitext(os.path.basename(args.script))[0]
    session = re.sub(r'-v\d+$', '', script_base).replace('-script', '')

    # --reprocess is shorthand for --skip-generate (reprocess existing audio with new script/config)
    if args.reprocess:
        args.skip_generate = True

    # --list-stages: show stage names and exit
    if args.list_stages:
        print(f"Session: {session}")
        print(f"Stages ({len(stages)}):")
        for i, s in enumerate(stages):
            print(f"  {i}: {s['name']} ({len(s['slices'])} slices, {len(s.get('cmds',[]))} cmds)")
        print(f"Interactives ({len(interactives)}):")
        for ix in interactives:
            print(f"  {ix['id']} [{ix['type']}] \"{ix['text'][:50]}\"")
        return

    # ── Load config JSON (auto-detect or explicit) ──
    config_path = args.config
    if not config_path:
        # Try same name as script but .json
        candidate = os.path.join(os.path.dirname(args.script), f"{session}.json")
        if os.path.exists(candidate):
            config_path = candidate

    session_config = {}
    if config_path and os.path.exists(config_path):
        with open(config_path) as f:
            session_config = json.load(f)
        print(f"Config: {config_path}")
        if session_config.get("id"):
            session = session_config["id"]

    # Merge CLI args > config > defaults
    voice = args.voice or session_config.get("voice", DEFAULT_VOICE)
    default_style = args.style or session_config.get("default_style", DEFAULT_STYLE)
    seed = args.seed if args.seed is not None else session_config.get("seed", 42)
    stage_configs = session_config.get("stages", {})

    # Output to session store format: public/sessions/{id}/
    out_dir = os.path.join("public", "sessions", session)
    raw_dir = os.path.join(out_dir, "raw")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(raw_dir, exist_ok=True)

    manifest_path = os.path.join(out_dir, "manifest.json")

    # Config-only mode: just regenerate TS from existing manifest
    if args.config_only:
        with open(manifest_path) as f:
            manifest = json.load(f)
        generate_session_config(manifest, args.script, stages)
        return

    print(f"Session: {session} | {len(stages)} stages")

    manifest = {"session": session, "voice": voice, "model": "gpro", "style": default_style, "stages": [], "interactive": []}

    for si, stage in enumerate(stages):
        # --stage filter: skip stages that don't match
        if args.stage and stage['name'] != args.stage:
            # Still need to add to manifest from existing data if available
            existing_wav = os.path.join(out_dir, f"{si:02d}_{stage['name']}.wav")
            existing_mp3 = os.path.join(out_dir, f"{si:02d}_{stage['name']}.mp3")
            if os.path.exists(existing_wav) or os.path.exists(existing_mp3):
                # Read existing manifest entry if available
                if os.path.exists(manifest_path):
                    with open(manifest_path) as _mf:
                        _existing = json.load(_mf)
                    for _es in _existing.get("stages", []):
                        if _es["name"] == stage['name']:
                            manifest["stages"].append(_es)
                            break
                print(f"\n── {stage['name']} (skipped — use --stage {stage['name']} to process) ──")
            continue

        print(f"\n── {stage['name']} ({len(stage['slices'])} slices) ──")

        # Generate full stage audio
        stage_path = os.path.join(raw_dir, f"{si:02d}_{stage['name']}.wav")
        full_text = " ".join(stage['slices'])

        # Style priority: script [STYLE:] > config JSON > CLI default
        sc = stage_configs.get(stage['name'], {})
        stage_style = stage.get('style') or sc.get('style') or default_style

        if not args.skip_generate or not os.path.exists(stage_path):
            # Split into API-sized chunks if needed
            chunks = []
            buf = ""
            for s in stage['slices']:
                if len(buf) + len(s) + 1 > MAX_CHARS:
                    if buf: chunks.append(buf.strip())
                    buf = s
                else:
                    buf = f"{buf} {s}" if buf else s
            if buf: chunks.append(buf.strip())

            chunk_files = []
            for ci, chunk in enumerate(chunks):
                print(f"  gen {ci+1}/{len(chunks)} ({len(chunk)} chars)...", end=" ", flush=True)
                url, credits = generate_audio(chunk, voice, stage_style, seed + si * 10 + ci)
                if url:
                    cp = os.path.join(raw_dir, f"{si:02d}_{stage['name']}_c{ci}.wav")
                    download(url, cp)
                    print(f"{wav_duration(cp):.0f}s | {credits} credits")
                    chunk_files.append(cp)
                else:
                    print("FAILED")
                time.sleep(0.5)

            if len(chunk_files) == 1:
                os.rename(chunk_files[0], stage_path)
            elif len(chunk_files) > 1:
                lst = os.path.join(raw_dir, "concat.txt")
                with open(lst, 'w') as f:
                    for cf in chunk_files: f.write(f"file '{os.path.abspath(cf)}'\n")
                subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", stage_path], capture_output=True)
                for cf in chunk_files: os.remove(cf)
                os.remove(lst)
            elif not os.path.exists(stage_path):
                print("  ERROR: no audio"); continue

        stage_dur = wav_duration(stage_path)
        print(f"  raw: {stage_dur:.0f}s")

        # ── Transcribe raw audio (script-constrained for best accuracy) ──
        # Build known text — strip ellipsis pauses (... is not spoken)
        known_text = " ".join(stage['slices'])
        known_text = re.sub(r'\.{2,}', '', known_text)  # remove ... and ..
        known_text = re.sub(r'\s+', ' ', known_text).strip()
        print(f"  transcribe (script-constrained)...", end=" ", flush=True)
        words = transcribe(stage_path, args.whisper_model, known_text=known_text)
        if words:
            print(f"{len(words)} words")
        else:
            print("fallback (no whisper)")

        # ── Post-process: insert pauses, stretch, effects ──
        stage_public = os.path.join(out_dir, f"{si:02d}_{stage['name']}.wav")

        if HAS_POSTPROCESS and words:
            print(f"  postprocess...", flush=True)
            pp_opts = get_stage_opts(stage['name'])
            # Apply overrides from config JSON
            for k in ('speed', 'pause_scale', 'reverb_wet', 'reverb_full', 'whisper_layer', 'whisper_volume'):
                if k in sc:
                    pp_opts[k] = sc[k]
            # Apply per-stage overrides from script (highest priority)
            if stage.get('speed') is not None:
                pp_opts['speed'] = stage['speed']

            # Find command word indices in Whisper output
            cmd_indices = set()
            if stage.get('cmds'):
                cmd_indices = _find_cmd_word_indices(words, stage['cmds'])

            result = postprocess_stage(stage_path, words, stage['slices'], pp_opts, cmd_indices)
            shutil.copy2(result["audio_path"], stage_public)
            words = result["whisper_words"]
            stage_dur = result["duration"]

            # No re-transcription needed — the postprocessor tracks all transformations
            # deterministically (time-stretch scale + cumulative pause shifts).
            # Word timestamps from the postprocessor ARE the final timestamps.
            print(f"  timestamps: deterministic ({len(words)} words, shifts tracked)")
        else:
            # No post-processing — just copy raw to public
            if os.path.abspath(stage_path) != os.path.abspath(stage_public):
                shutil.copy2(stage_path, stage_public)

        lines = []
        if words:
            cuts = find_cuts(words, stage['slices'])
            if cuts:
                for ct in cuts:
                    entry = {
                        "text": ct["text"],
                        "startTime": round(ct["startTime"], 3),
                        "endTime": round(ct["end"], 3),
                        "duration": round(ct["end"] - ct["startTime"], 2),
                    }
                    if ct.get("words"):
                        entry["words"] = ct["words"]
                    # Add interaction type if tagged
                    slice_idx = ct["index"]
                    if slice_idx < len(stage.get('slice_types', [])):
                        stype = stage['slice_types'][slice_idx]
                        if stype != 'narration':
                            entry["type"] = stype
                    lines.append(entry)

                # Fix last line if Whisper ran out — extend to fill remaining stage audio
                if lines and lines[-1]["duration"] < 2.0:
                    prev_end = lines[-2]["endTime"] if len(lines) > 1 else 0
                    lines[-1]["startTime"] = round(prev_end, 3)
                    lines[-1]["endTime"] = round(stage_dur, 3)
                    lines[-1]["duration"] = round(stage_dur - prev_end, 2)
                    # Estimate word timings evenly across the duration
                    if lines[-1].get("words"):
                        n = len(lines[-1]["words"])
                        dur = lines[-1]["duration"]
                        for wi, w in enumerate(lines[-1]["words"]):
                            w["start"] = round(wi / n * dur, 3)
                            w["end"] = round((wi + 1) / n * dur, 3)
            else:
                lines = _duration_based_lines(stage['slices'], stage_dur)
        else:
            print("fallback (no whisper)")
            lines = _duration_based_lines(stage['slices'], stage_dur)

        stage_entry = {
            "name": stage['name'],
            "file": f"sessions/{session}/{si:02d}_{stage['name']}.wav",
            "duration": round(stage_dur, 2),
            "lines": lines,
        }
        if stage.get('interlude', 0) > 0:
            stage_entry["interlude"] = stage['interlude']
        manifest["stages"].append(stage_entry)
        interlude_str = f" + {stage['interlude']}s interlude" if stage.get('interlude') else ""
        print(f"  {len(lines)} lines mapped, {stage_dur:.0f}s continuous{interlude_str}")

    # ── Generate interactive clips (standalone audio) ──
    for ii, ix in enumerate(interactives):
        print(f"\n── interactive: {ix['id']} ({ix['type']}) ──")
        ix_path = os.path.join(out_dir, f"{ix['id']}.wav")

        if not args.skip_generate or not os.path.exists(ix_path):
            ix_configs = session_config.get('interactive', {})
            ix_style = ix_configs.get(ix['id'], {}).get('style') or default_style
            print(f"  gen ({len(ix['text'])} chars)...", end=" ", flush=True)
            url, credits = generate_audio(ix['text'], voice, ix_style, seed + 900 + ii)
            if url:
                download(url, ix_path)
                print(f"{wav_duration(ix_path):.1f}s | {credits} credits")
            else:
                print("FAILED"); continue

        if os.path.exists(ix_path):
            # Transcribe for word timings
            ix_words = transcribe(ix_path, args.whisper_model, known_text=ix['text'])
            ix_dur = wav_duration(ix_path)

            ix_entry = {
                "id": ix['id'],
                "type": ix['type'],
                "file": f"sessions/{session}/{ix['id']}.wav",
                "text": ix['text'],
                "duration": round(ix_dur, 2),
            }
            if ix_words:
                ix_entry["words"] = [{"word": w["word"], "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in ix_words]

            manifest["interactive"].append(ix_entry)
            print(f"  {ix['type']}: \"{ix['text'][:50]}\" ({ix_dur:.1f}s)")

    # Add any other interactive clips already in the directory
    existing = {i["id"] for i in manifest["interactive"]}
    for f in sorted(os.listdir(out_dir)):
        if not f.endswith('.wav') or f[0].isdigit(): continue
        name = f.replace('.wav', '')
        if name in existing: continue
        try:
            manifest["interactive"].append({"id": name, "file": f"sessions/{session}/{f}", "duration": round(wav_duration(os.path.join(out_dir, f)), 2)})
        except: pass

    # Write manifest
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Generate session package (session.json + update sessions.json index)
    generate_session_package(manifest, session_config, out_dir)

    # Also generate TypeScript texts (backward compat during migration)
    generate_session_config(manifest, args.script, stages)

    # Summary
    total_lines = sum(len(s["lines"]) for s in manifest["stages"])
    total_dur = sum(l["duration"] for s in manifest["stages"] for l in s["lines"])
    print(f"\n{'='*50}")
    print(f"Done! {total_lines} lines, {total_dur:.0f}s audio, {len(manifest['interactive'])} interactive")
    print(f"Manifest: {manifest_path}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
