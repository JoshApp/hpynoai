#!/bin/bash
# HPYNO Voice Pipeline Runner
#
# Usage:
#   ./scripts/run-pipeline.sh scripts/relax.txt                  # full pipeline
#   ./scripts/run-pipeline.sh scripts/relax.txt --skip-generate   # reprocess only
#   ./scripts/run-pipeline.sh scripts/relax.txt --config-only     # rebuild config only
#
# First run will set up the Python venv automatically.

set -e
cd "$(dirname "$0")/.."

VENV=".venv"
PYTHON="$VENV/bin/python"

# ── Ensure venv exists ──
if [ ! -f "$PYTHON" ]; then
    echo "Setting up Python venv..."
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --quiet librosa soundfile scipy numpy faster-whisper
    echo "Venv ready."
fi

# ── Check deps ──
"$PYTHON" -c "import librosa, soundfile, faster_whisper" 2>/dev/null || {
    echo "Installing missing dependencies..."
    "$VENV/bin/pip" install --quiet librosa soundfile scipy numpy faster-whisper
}

# ── Run pipeline ──
echo ""
"$PYTHON" scripts/generate-session.py "$@"
