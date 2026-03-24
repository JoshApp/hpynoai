#!/bin/bash
# HPYNO Reprocess Runner — post-process existing audio without regenerating voice
#
# Usage:
#   ./scripts/run-reprocess.sh              # reprocess relax → relax-v2
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

# ── Run reprocess ──
echo ""
"$PYTHON" scripts/reprocess-relax.py "$@"
