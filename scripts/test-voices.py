#!/usr/bin/env python3
"""
Test different voice styles for sleep session.
Generates short clips with the same text but different style prompts.

Usage:
  export SEXYVOICE_API_KEY="your-key"
  .venv/bin/python scripts/test-voices.py
"""

import json, os, sys, urllib.request, time

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

if not API_KEY:
    print("Set SEXYVOICE_API_KEY first:")
    print("  export SEXYVOICE_API_KEY='your-key'")
    sys.exit(1)

OUT_DIR = "public/audio/voice-tests"
os.makedirs(OUT_DIR, exist_ok=True)

# Same text for all tests — a sleep-appropriate phrase
TEST_TEXT = "just let your body sink... into the bed... there's nothing you need to do... nowhere you need to be... just here... just this warmth..."

STYLES = {
    "01_calm_guide": "calm, gentle, warm, like a meditation guide, slow with long pauses between phrases",
    "02_intimate_whisper": "very intimate whispering, barely audible, soft breath sounds, like speaking directly into someone's ear in bed",
    "03_slow_dreamy": "extremely slow and dreamy, each word floating in space, hypnotic monotone, like drifting in and out of consciousness",
    "04_warm_maternal": "warm and nurturing, like a mother soothing a child to sleep, soft and tender, gentle",
    "05_deep_resonant": "deep, resonant, with chest voice, slow and deliberate, like a warm blanket wrapping around you",
    "06_asmr_breathy": "asmr style, very breathy and close, soft mouth sounds between words, intimate and close",
    "07_hypnotic_monotone": "hypnotic monotone, minimal pitch variation, steady and predictable, metronomic pacing, sleep-inducing",
    "08_ethereal_distant": "ethereal and distant, as if the voice is coming from far away, echoing, dissolving into air",
}

def generate(text, style, seed=42):
    payload = json.dumps({
        "model": "gpro", "voice": "zephyr",
        "input": text, "style": style,
        "response_format": "wav", "seed": seed,
    }).encode()

    req = urllib.request.Request(API_URL, data=payload, headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    })

    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            result = json.loads(resp.read())
            return result.get("url"), result.get("credits_remaining", "?")
    except Exception as e:
        print(f"  ERROR: {e}")
        return None, None

def download(url, path):
    import subprocess
    subprocess.run(["curl", "-s", "-L", "-o", path, url], check=True, timeout=30)

print(f"Generating {len(STYLES)} voice style tests...")
print(f"Text: \"{TEST_TEXT[:60]}...\"")
print()

for name, style in STYLES.items():
    path = os.path.join(OUT_DIR, f"{name}.wav")
    if os.path.exists(path):
        print(f"  {name}: already exists, skipping")
        continue

    print(f"  {name}...", end=" ", flush=True)
    url, credits = generate(TEST_TEXT, style)
    if url:
        download(url, path)
        print(f"done ({credits} credits)")
    else:
        print("FAILED")
    time.sleep(0.5)

print(f"\nDone! Listen to files in {OUT_DIR}/")
print("Compare styles to pick the best fit for the sleep session.")
print()
print("Styles tested:")
for name, style in STYLES.items():
    print(f"  {name}: {style[:70]}...")
