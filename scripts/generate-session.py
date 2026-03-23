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

import json, sys, os, re, wave, time, subprocess, urllib.request, argparse

API_URL = "https://sexyvoice.ai/api/v1/speech"
API_KEY = os.environ.get("SEXYVOICE_API_KEY", "")
DEFAULT_STYLE = "very slow and deliberate, long pauses between phrases, hypnotic, soft dominance, breathy"
DEFAULT_VOICE = "zephyr"
MAX_CHARS = 950


# ── Script Parser ──

def parse_script(path):
    """Parse script.txt into stages with slices and gates."""
    stages = []
    current = None

    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue

            m = re.match(r'\[STAGE:\s*(.+?)\]', line)
            if m:
                if current:
                    _flush(current)
                    stages.append(current)
                current = {'name': m.group(1).strip(), 'slices': [], 'gates': [], '_buf': ''}
                continue

            if not current:
                continue

            m = re.match(r'\[GATE:\s*(.+?)\]', line)
            if m:
                current['gates'].append(m.group(1).strip())
                continue

            if line == '[SLICE]':
                _flush(current)
                continue

            if line == '[PAUSE]':
                current['_buf'] += '... '
                continue

            current['_buf'] += line + ' '

    if current:
        _flush(current)
        stages.append(current)

    for s in stages:
        del s['_buf']
        s['slices'] = [re.sub(r'\s+', ' ', t).strip() for t in s['slices']]

    return stages


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


# ── Whisper ──

_whisper_model = None

def transcribe(audio_path, model_size="base"):
    global _whisper_model
    try:
        import whisper
    except ImportError:
        return None

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
            entry = {"file": f"audio/{os.path.basename(out_dir)}/{fname}", "text": ct["text"], "duration": round(dur, 2)}
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
            files.append({"file": f"audio/{os.path.basename(out_dir)}/{fname}", "text": text, "duration": round(wav_duration(out_path), 2)})
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

    # Also export stage durations so the session config can use them
    config_lines.append("")
    config_lines.append("// Stage durations from audio (use these in session config)")
    config_lines.append("export const stageDurations: Record<string, number> = {")
    for stage in manifest["stages"]:
        dur = stage.get("duration", 0)
        # Add 5s buffer for interaction/transition time
        config_lines.append(f"  '{stage['name']}': {round(dur + 5)},")
    config_lines.append("};")

    out_path = os.path.join("src", "sessions", f"{session_id}-texts.ts")
    with open(out_path, "w") as f:
        f.write("\n".join(config_lines) + "\n")

    print(f"  Generated: {out_path}")
    return out_path


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description="HPYNO voice pipeline")
    parser.add_argument("script", help="Session script .txt")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--style", default=DEFAULT_STYLE)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--whisper-model", default="base")
    parser.add_argument("--skip-generate", action="store_true", help="Skip API, use existing raw audio")
    parser.add_argument("--config-only", action="store_true", help="Only rebuild config from existing manifest")
    args = parser.parse_args()

    stages = parse_script(args.script)
    session = os.path.splitext(os.path.basename(args.script))[0].replace('-v2', '').replace('-script', '')

    out_dir = os.path.join("public", "audio", session)
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

    manifest = {"session": session, "voice": args.voice, "model": "gpro", "style": args.style, "stages": [], "interactive": []}

    for si, stage in enumerate(stages):
        print(f"\n── {stage['name']} ({len(stage['slices'])} slices) ──")

        # Generate full stage audio
        stage_path = os.path.join(raw_dir, f"{si:02d}_{stage['name']}.wav")
        full_text = " ".join(stage['slices'])

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
                url, credits = generate_audio(chunk, args.voice, args.style, args.seed + si * 10 + ci)
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

        # Copy raw audio to public dir as the stage file (no slicing!)
        stage_public = os.path.join(out_dir, f"{si:02d}_{stage['name']}.wav")
        if os.path.abspath(stage_path) != os.path.abspath(stage_public):
            import shutil
            shutil.copy2(stage_path, stage_public)

        # Transcribe to get line timing
        print(f"  transcribe...", end=" ", flush=True)
        words = transcribe(stage_path, args.whisper_model)

        lines = []
        if words:
            print(f"{len(words)} words")
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
            "file": f"audio/{session}/{si:02d}_{stage['name']}.wav",
            "duration": round(stage_dur, 2),
            "lines": lines,
        }
        manifest["stages"].append(stage_entry)
        print(f"  {len(lines)} lines mapped, {stage_dur:.0f}s continuous")

        # Gates
        for gi, gate in enumerate(stage['gates']):
            gid = f"gate_{stage['name']}_{gi}"
            gpath = os.path.join(out_dir, f"{gid}.wav")
            if not args.skip_generate or not os.path.exists(gpath):
                print(f"  gate: \"{gate}\"...", end=" ", flush=True)
                url, credits = generate_audio(gate, args.voice, args.style, args.seed + 900 + si * 10 + gi)
                if url:
                    download(url, gpath)
                    print(f"{wav_duration(gpath):.1f}s")
                else:
                    print("FAILED"); continue

            if os.path.exists(gpath):
                manifest["interactive"].append({"id": gid, "file": f"audio/{session}/{gid}.wav", "text": gate, "duration": round(wav_duration(gpath), 2)})

    # Add any other interactive clips in the directory
    existing = {i["id"] for i in manifest["interactive"]}
    for f in sorted(os.listdir(out_dir)):
        if not f.endswith('.wav') or f[0].isdigit(): continue
        name = f.replace('.wav', '')
        if name in existing: continue
        try:
            manifest["interactive"].append({"id": name, "file": f"audio/{session}/{f}", "duration": round(wav_duration(os.path.join(out_dir, f)), 2)})
        except: pass

    # Write manifest
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    # Generate TypeScript texts
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
