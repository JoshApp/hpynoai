#!/bin/bash
# HPYNO Reprocess Runner — post-process existing audio without regenerating voice
#
# Usage:
#   ./scripts/run-reprocess.sh              # reprocess relax → relax-v2
#
# Uses .venv-whisperx (Python 3.12, WhisperX forced alignment) if available,
# falls back to .venv (Python 3.14, faster-whisper).

set -e
cd "$(dirname "$0")/.."

# Prefer whisperx venv (Python 3.12) for forced alignment
if [ -f ".venv-whisperx/bin/python" ]; then
    PYTHON=".venv-whisperx/bin/python"
    echo "Using WhisperX venv (forced alignment)"
elif [ -f ".venv/bin/python" ]; then
    PYTHON=".venv/bin/python"
    echo "Using standard venv (faster-whisper)"
else
    echo "No venv found. Run:"
    echo "  python3.12 -m venv .venv-whisperx && .venv-whisperx/bin/pip install whisperx librosa soundfile pyrubberband"
    exit 1
fi

echo ""
"$PYTHON" scripts/reprocess-relax.py "$@"
