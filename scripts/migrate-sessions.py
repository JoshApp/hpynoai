#!/usr/bin/env python3
"""
Migrate existing sessions to the new session store format.

Reads existing manifest.json + session configs and creates:
  public/sessions.json           — session index
  public/sessions/{id}/session.json  — full config per session
  public/sessions/{id}/manifest.json — audio manifest (copied)
  public/sessions/{id}/*.mp3        — audio files (copied/symlinked)

Run once to set up the store, then the pipeline handles new sessions.
"""

import json, os, shutil, sys

# Sessions to migrate — (id, audio_dir, has_audio)
SESSIONS = [
    ("relax", "public/audio/relax"),
]

# Session configs — these mirror the TypeScript SessionConfig
# In production, the pipeline generates these from the JSON config
CONFIGS = {
    "relax": {
        "id": "relax",
        "name": "Relax",
        "description": "An immersive descent into deep relaxation — utilization, embedded commands, and sensory deepening.",
        "icon": "\U0001F30A",
        "theme": {
            "textColor": "#c8b8ff",
            "textGlow": "rgba(160, 120, 255, 0.6)",
            "primaryColor": [0.45, 0.25, 0.85],
            "secondaryColor": [0.25, 0.3, 0.75],
            "accentColor": [0.6, 0.4, 1.0],
            "bgColor": [0.03, 0.02, 0.08],
            "particleColor": [0.5, 0.35, 0.9],
            "breatheColor": "rgba(160, 120, 255, 0.35)",
        },
        "audio": {
            "binauralRange": [10, 4],
            "carrierFreq": 120,
            "droneFreq": 60,
            "droneFifth": 90,
            "lfoSpeed": 0.08,
            "filterCutoff": 600,
            "warmth": 0.7,
        },
        "photoWarning": True,
        "contentWarning": None,
    },
}

# Stage configs — merge with generated data from manifest
STAGE_CONFIGS = {
    "relax": {
        "settle": {"intensity": 0.15, "textInterval": 10, "breathCycle": 14, "breathPattern": {"inhale": 5, "holdIn": 3, "exhale": 6}, "spiralSpeed": 0.8, "interactions": [{"type": "breath-sync", "triggerAt": 0, "duration": 30, "data": {"clipId": "relax_breathe"}}], "ambient": {"melodyLevel": 0.4, "noiseLevel": 0.15, "filterMax": 1400, "padLevel": 0.35}},
        "induction": {"intensity": 0.3, "textInterval": 9, "breathCycle": 10, "breathPattern": {"inhale": 4, "holdIn": 1, "exhale": 5}, "spiralSpeed": 0.8, "ambient": {"melodyLevel": 0.3, "noiseLevel": 0.2, "filterMax": 1200, "padLevel": 0.4}},
        "deepening": {"intensity": 0.55, "textInterval": 9, "breathCycle": 11, "breathPattern": {"inhale": 4, "holdIn": 2, "exhale": 6}, "spiralSpeed": 0.65, "fractionationDip": 0.3, "interactions": [{"type": "gate", "triggerAt": 115, "duration": 10, "data": {"text": "would you like to go deeper?", "clipId": "relax_deeper"}}], "ambient": {"melodyLevel": 0.15, "noiseLevel": 0.3, "filterMax": 900, "padLevel": 0.45}},
        "post_gate": {"intensity": 0.6, "textInterval": 12, "breathCycle": 11, "breathPattern": {"inhale": 4, "holdIn": 2, "exhale": 6}, "spiralSpeed": 0.6, "ambient": {"melodyLevel": 0.1, "noiseLevel": 0.35, "filterMax": 800, "padLevel": 0.5}},
        "trance": {"intensity": 0.8, "textInterval": 10, "breathCycle": 12, "breathPattern": {"inhale": 4, "holdIn": 3, "exhale": 8}, "spiralSpeed": 0.5, "fractionationDip": 0.4, "ambient": {"melodyLevel": 0, "noiseLevel": 0.4, "filterMax": 600, "padLevel": 0.55, "warmth": 0.85}},
        "deep": {"intensity": 0.95, "textInterval": 12, "breathCycle": 13, "breathPattern": {"inhale": 4, "holdIn": 4, "exhale": 8, "holdOut": 4}, "spiralSpeed": 0.3, "ambient": {"melodyLevel": 0, "noiseLevel": 0.5, "filterMax": 400, "padLevel": 0.6, "warmth": 0.95}},
        "emergence": {"intensity": 0.3, "textInterval": 8, "breathCycle": 10, "breathPattern": {"inhale": 5, "exhale": 5}, "spiralSpeed": 0.85, "ambient": {"melodyLevel": 0.35, "noiseLevel": 0.15, "filterMax": 1400, "padLevel": 0.35, "warmth": 0.6}},
    },
}


def migrate_session(session_id, audio_dir):
    print(f"\n{'='*50}")
    print(f"  Migrating: {session_id}")
    print(f"{'='*50}")

    out_dir = f"public/sessions/{session_id}"
    os.makedirs(out_dir, exist_ok=True)

    # Load manifest
    manifest_path = os.path.join(audio_dir, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"  SKIP: no manifest at {manifest_path}")
        return None

    with open(manifest_path) as f:
        manifest = json.load(f)

    # Copy audio files
    for stage in manifest.get("stages", []):
        src = os.path.join("public", stage["file"])
        fname = os.path.basename(stage["file"])
        dst = os.path.join(out_dir, fname)
        if os.path.exists(src):
            shutil.copy2(src, dst)
            stage["file"] = f"sessions/{session_id}/{fname}"
        else:
            print(f"  WARN: missing {src}")

    for ix in manifest.get("interactive", []):
        src = os.path.join("public", ix["file"])
        fname = os.path.basename(ix["file"])
        dst = os.path.join(out_dir, fname)
        if os.path.exists(src):
            shutil.copy2(src, dst)
            ix["file"] = f"sessions/{session_id}/{fname}"

    # Copy effects files
    for f in os.listdir(audio_dir):
        if f.endswith('.effects.json'):
            shutil.copy2(os.path.join(audio_dir, f), os.path.join(out_dir, f))

    # Write manifest with updated paths
    with open(os.path.join(out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    # Build session.json
    config = dict(CONFIGS.get(session_id, {}))
    stage_cfgs = STAGE_CONFIGS.get(session_id, {})

    stages = []
    for ms in manifest["stages"]:
        sc = dict(stage_cfgs.get(ms["name"], {}))
        sc["name"] = ms["name"]
        sc["duration"] = ms["duration"]
        sc.setdefault("intensity", 0.5)
        sc.setdefault("textInterval", 9)
        sc.setdefault("breathCycle", 10)
        sc.setdefault("spiralSpeed", 0.7)

        # Texts from manifest lines
        sc["texts"] = [line["text"] for line in ms.get("lines", [])]

        # Interlude
        if ms.get("interlude"):
            sc["interlude"] = ms["interlude"]

        stages.append(sc)

    config["stages"] = stages

    with open(os.path.join(out_dir, "session.json"), "w") as f:
        json.dump(config, f, indent=2)

    print(f"  Created: {out_dir}/session.json ({len(stages)} stages)")
    print(f"  Created: {out_dir}/manifest.json")

    return config


def main():
    os.makedirs("public/sessions", exist_ok=True)

    index = {"version": 1, "sessions": []}

    for session_id, audio_dir in SESSIONS:
        config = migrate_session(session_id, audio_dir)
        if not config:
            continue

        # Build summary for index
        theme = config.get("theme", {})
        index["sessions"].append({
            "id": config["id"],
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

    # Also add placeholder sessions (sleep, focus, erotic) with no audio
    placeholders = [
        {"id": "sleep", "name": "Sleep", "description": "Drift into deep, restful sleep.", "icon": "\U0001F319"},
        {"id": "focus", "name": "Focus", "description": "Sharpen your concentration and clarity.", "icon": "\U0001F3AF"},
        {"id": "erotic", "name": "Surrender", "description": "An intimate journey of letting go.", "icon": "\U0001F525"},
    ]
    for p in placeholders:
        index["sessions"].append({
            **p,
            "contentWarning": "This session contains erotic content.\n18+ only." if p["id"] == "erotic" else None,
            "photoWarning": True,
            "themePreview": {
                "primaryColor": [0.5, 0.3, 0.8],
                "secondaryColor": [0.3, 0.3, 0.7],
                "accentColor": [0.6, 0.4, 1.0],
                "bgColor": [0.03, 0.02, 0.08],
                "particleColor": [0.5, 0.35, 0.9],
                "textColor": "#c8a0ff",
                "textGlow": "rgba(200,160,255,0.4)",
                "breatheColor": "rgba(160,120,255,0.35)",
            },
        })

    with open("public/sessions.json", "w") as f:
        json.dump(index, f, indent=2)

    print(f"\n{'='*50}")
    print(f"  Index: public/sessions.json ({len(index['sessions'])} sessions)")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
