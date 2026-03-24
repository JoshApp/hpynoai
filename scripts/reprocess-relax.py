#!/usr/bin/env python3
"""
Reprocess existing relax session audio → relax-v2.

Takes the raw WAV files, applies post-processing (pauses, stretch, reverb,
whisper layer), re-transcribes, and outputs a new manifest + MP3s.

No voice generation — just post-processing the existing takes.

Usage:
  pip install librosa soundfile scipy numpy openai-whisper
  python3 scripts/reprocess-relax.py
"""

import json, os, sys, shutil, subprocess

sys.path.insert(0, os.path.dirname(__file__))
from postprocess import postprocess_stage, get_stage_opts

# Import transcription from the main pipeline (uses WhisperX with Whisper fallback)
from importlib import import_module
gs = import_module('generate-session')
transcribe = gs.transcribe

# ── Config ──
WHISPER_MODEL = "medium"  # base=fast/rough, medium=accurate, large=best

# ── Paths ──
RAW_DIR = "public/audio/relax/raw"
OUT_DIR = "public/audio/relax-v2"
MANIFEST_SRC = "public/audio/relax/manifest.json"

STAGES = [
    ("00_settle",    "settle"),
    ("01_induction", "induction"),
    ("02_deepening", "deepening"),
    ("03_trance",    "trance"),
    ("04_deep",      "deep"),
    ("05_emergence", "emergence"),
]

# Load config for per-stage settings
with open("scripts/relax.json") as f:
    config = json.load(f)
stage_configs = config.get("stages", {})

# Load original manifest for slice info
with open(MANIFEST_SRC) as f:
    orig_manifest = json.load(f)

# ── CMD words from the new script ──
# These are the embedded commands we want emphasized
CMD_PHRASES = {
    "settle": ["just here", "just now"],
    "induction": ["to relax"],
    "deepening": ["let it soften", "let it go", "permission to stop trying", "let yourself sink"],
    "trance": ["just allow this to happen", "deeper now", "everything carries you deeper"],
    "deep": ["pure stillness", "complete peace"],
    "emergence": [],
}

def clean_word(w):
    import re
    return re.sub(r'[.,!?]+$', '', w.replace('...', '').replace('\u2026', '')).strip()

def find_cmd_indices(whisper_words, cmd_phrases):
    """Find word indices matching command phrases."""
    indices = set()
    clean = [clean_word(w["word"]).lower() for w in whisper_words]
    for phrase in cmd_phrases:
        words = [clean_word(w).lower() for w in phrase.split() if clean_word(w)]
        if not words:
            continue
        for i in range(len(clean) - len(words) + 1):
            if all(clean[i+j] == words[j] for j in range(len(words))):
                for j in range(len(words)):
                    indices.add(i + j)
                break
    return indices


def wav_to_mp3(wav_path, mp3_path):
    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-codec:a", "libmp3lame", "-b:a", "128k", mp3_path],
        capture_output=True, timeout=30,
    )


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    new_manifest = {
        "session": "relax",
        "voice": config["voice"],
        "model": config["model"],
        "style": config["default_style"],
        "postprocessed": True,
        "stages": [],
        "interactive": orig_manifest.get("interactive", []),
    }

    for filename, stage_name in STAGES:
        raw_path = os.path.join(RAW_DIR, f"{filename}.wav")
        if not os.path.exists(raw_path):
            print(f"SKIP {stage_name}: {raw_path} not found")
            continue

        print(f"\n{'='*50}")
        print(f"Stage: {stage_name}")
        print(f"{'='*50}")

        # Step 1: Transcribe raw audio
        print("  [1/4] Transcribe raw audio...")
        words = transcribe(raw_path, WHISPER_MODEL)
        print(f"         {len(words)} words")

        # Step 2: Build post-processing options
        pp_opts = get_stage_opts(stage_name)
        sc = stage_configs.get(stage_name, {})
        for k in ('speed', 'pause_scale', 'reverb_wet', 'reverb_full', 'whisper_layer', 'whisper_volume'):
            if k in sc:
                pp_opts[k] = sc[k]

        # Find CMD word indices
        cmd_indices = find_cmd_indices(words, CMD_PHRASES.get(stage_name, []))
        if cmd_indices:
            print(f"         {len(cmd_indices)} command words marked")

        # Step 3: Post-process
        print(f"  [2/4] Post-process (speed={pp_opts['speed']}, pauses={pp_opts['pause_scale']}x, reverb={pp_opts['reverb_wet']})...")
        result = postprocess_stage(raw_path, words, [], pp_opts, cmd_indices)
        processed_path = result["audio_path"]
        effects = result.get("effects", {})
        print(f"         {result['duration']:.1f}s (was {words[-1]['end']:.1f}s)")

        # Step 4: Re-transcribe processed audio
        print("  [3/4] Re-transcribe processed audio...")
        new_words = transcribe(processed_path, WHISPER_MODEL)
        if new_words:
            print(f"         {len(new_words)} words (updated)")
            words = new_words
        else:
            print(f"         using original timestamps")
            words = result["whisper_words"]

        # ── Rebuild ALL effects metadata from re-transcribed words ──
        # This ensures everything lines up with the final audio

        # Pauses: significant gaps between words
        actual_pauses = []
        for i in range(1, len(words)):
            gap = words[i]["start"] - words[i-1]["end"]
            if gap > 0.8:
                actual_pauses.append({
                    "at": round(words[i-1]["end"], 3),
                    "duration": round(gap, 3),
                })
        effects["pauses_inserted"] = actual_pauses

        # CMD words: match against re-transcribed positions
        effects["cmd_words"] = []
        new_cmd_indices = find_cmd_indices(words, CMD_PHRASES.get(stage_name, []))
        for wi in new_cmd_indices:
            if wi < len(words):
                w = words[wi]
                effects["cmd_words"].append({
                    "start": round(w["start"], 3),
                    "end": round(w["end"], 3),
                    "word": w["word"],
                })

        # Reverb regions: only when stage actually has reverb applied
        has_reverb = sc.get("reverb_wet", 0) > 0 or sc.get("reverb_full", 0) > 0
        reverb_regions = []

        if has_reverb:
            all_gaps = []
            for i in range(len(words) - 1):
                all_gaps.append(words[i + 1]["start"] - words[i]["end"])
            median_gap = sorted(all_gaps)[len(all_gaps) // 2] if all_gaps else 0.2

            ramp_sec = 1.2
            decay_sec = 1.2
            is_first = True
            for i in range(len(words) - 1):
                gap = all_gaps[i]
                if gap > 0.4 or (gap > 0.15 and gap > median_gap * 2):
                    if is_first:
                        is_first = False
                        continue
                    word_end = words[i]["end"]
                    next_start = words[i + 1]["start"]
                    reverb_regions.append({
                        "start": round(max(0, word_end - ramp_sec), 3),
                        "end": round(min(word_end + decay_sec, next_start), 3),
                        "wet": sc.get("reverb_wet", 0),
                    })
        effects["reverb_regions"] = reverb_regions

        # Save effects metadata for debug visualization
        effects_path = os.path.join(OUT_DIR, f"{filename}.effects.json")
        with open(effects_path, "w") as ef:
            json.dump(effects, ef, indent=2)

        # Step 5: Convert to MP3 and build manifest
        print("  [4/4] Convert to MP3...")
        out_wav = os.path.join(OUT_DIR, f"{filename}.wav")
        out_mp3 = os.path.join(OUT_DIR, f"{filename}.mp3")
        shutil.copy2(processed_path, out_wav)
        wav_to_mp3(out_wav, out_mp3)
        os.remove(out_wav)  # keep only MP3

        # Clean up processed WAV from raw dir
        if os.path.exists(processed_path) and processed_path != raw_path:
            os.remove(processed_path)

        # Build manifest entry from original (keep slice structure, update timestamps)
        orig_stage = next((s for s in orig_manifest["stages"] if s["name"] == stage_name), None)
        if orig_stage:
            # Re-slice using new word timestamps
            slices = [line["text"] for line in orig_stage["lines"]]
            cuts = gs.find_cuts(words, slices)

            lines = []
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
                    # Preserve interaction type from original
                    orig_line = next((l for l in orig_stage["lines"] if l["text"] == ct["text"]), None)
                    if orig_line and orig_line.get("type"):
                        entry["type"] = orig_line["type"]
                    lines.append(entry)

            new_manifest["stages"].append({
                "name": stage_name,
                "file": f"audio/relax-v2/{filename}.mp3",
                "duration": round(result["duration"], 2),
                "lines": lines,
            })

        print(f"  Done: {result['duration']:.1f}s")

    # Write manifest
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(new_manifest, f, indent=2)

    total_dur = sum(s["duration"] for s in new_manifest["stages"])
    orig_dur = sum(s["duration"] for s in orig_manifest["stages"])
    print(f"\n{'='*50}")
    print(f"Done! relax-v2")
    print(f"  Original: {orig_dur:.0f}s")
    print(f"  Processed: {total_dur:.0f}s ({total_dur/orig_dur:.0%} of original)")
    print(f"  Manifest: {manifest_path}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
