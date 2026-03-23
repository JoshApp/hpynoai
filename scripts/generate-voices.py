#!/usr/bin/env python3
"""
Generate voice lines for HPYNO sessions using SexyVoice.ai API.
Reads a script JSON, generates each line, saves WAV files, outputs a manifest.

Usage: python3 scripts/generate-voices.py scripts/surrender-script.json
"""

import json
import sys
import os
import wave
import time
import urllib.request
import urllib.error

API_URL = "https://sexyvoice.ai/api/v1/speech"
API_KEY = os.environ.get("SEXYVOICE_API_KEY", "")

def get_wav_duration(path):
    """Get duration of a WAV file in seconds."""
    with wave.open(path, 'rb') as w:
        frames = w.getnframes()
        rate = w.getframerate()
        return frames / float(rate)

def generate_line(text, voice, model, style, seed=None):
    """Call SexyVoice API and return (audio_url, credits_remaining)."""
    payload = {
        "model": model,
        "voice": voice,
        "input": text,
        "style": style,
        "response_format": "wav",
    }
    if seed is not None:
        payload["seed"] = seed

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=data,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("url"), result.get("credits_remaining", "?")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"  API error {e.code}: {body}")
        return None, None

def download_file(url, path):
    """Download a file from URL to local path using curl (handles CDN auth)."""
    import subprocess
    result = subprocess.run(
        ["curl", "-s", "-L", "-o", path, url],
        capture_output=True, timeout=30
    )
    if result.returncode != 0:
        raise Exception(f"curl failed: {result.stderr.decode()}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 generate-voices.py <script.json>")
        sys.exit(1)

    script_path = sys.argv[1]
    with open(script_path) as f:
        script = json.load(f)

    voice = script["voice"]
    model = script["model"]
    session_id = script["session"]
    styles = script["styles"]

    # Output directory
    out_dir = os.path.join("public", "audio", session_id)
    os.makedirs(out_dir, exist_ok=True)

    manifest = {
        "session": session_id,
        "voice": voice,
        "model": model,
        "stages": [],
    }

    total_lines = sum(len(stage["lines"]) for stage in script["stages"])
    generated = 0

    for si, stage in enumerate(script["stages"]):
        stage_name = stage["name"]
        stage_manifest = {
            "name": stage_name,
            "lines": [],
        }

        # Use a consistent seed per stage for voice consistency
        stage_seed = 42 + si * 100

        for li, line in enumerate(stage["lines"]):
            text = line["text"]
            style_key = line["style"]
            style_text = styles[style_key]

            filename = f"{si:02d}_{stage_name}_{li:02d}.wav"
            filepath = os.path.join(out_dir, filename)

            generated += 1
            print(f"[{generated}/{total_lines}] {stage_name}/{li:02d}: \"{text[:50]}...\"")
            print(f"  style: {style_key} | seed: {stage_seed + li}")

            # Check if already generated (skip if exists)
            if os.path.exists(filepath) and os.path.getsize(filepath) > 1000:
                duration = get_wav_duration(filepath)
                print(f"  -> exists, skipping ({duration:.1f}s)")
                stage_manifest["lines"].append({
                    "file": f"audio/{session_id}/{filename}",
                    "text": text,
                    "style": style_key,
                    "duration": round(duration, 2),
                })
                continue

            # Generate
            audio_url, credits = generate_line(
                text, voice, model, style_text, seed=stage_seed + li
            )

            if not audio_url:
                print(f"  -> FAILED, skipping")
                continue

            # Download
            download_file(audio_url, filepath)
            duration = get_wav_duration(filepath)

            print(f"  -> {filename} ({duration:.1f}s) | {credits} credits left")

            stage_manifest["lines"].append({
                "file": f"audio/{session_id}/{filename}",
                "text": text,
                "style": style_key,
                "duration": round(duration, 2),
            })

            # Small delay to avoid rate limiting
            time.sleep(0.5)

        manifest["stages"].append(stage_manifest)

    # Write manifest
    manifest_path = os.path.join(out_dir, "manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nDone! Manifest written to {manifest_path}")
    print(f"Total lines: {total_lines}")

    # Summary
    total_duration = 0
    for stage in manifest["stages"]:
        stage_dur = sum(l["duration"] for l in stage["lines"])
        total_duration += stage_dur
        print(f"  {stage['name']}: {len(stage['lines'])} lines, {stage_dur:.1f}s")
    print(f"  Total audio: {total_duration:.1f}s")

if __name__ == "__main__":
    main()
