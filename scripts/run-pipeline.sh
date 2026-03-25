#!/bin/bash
# HPYNO Voice Pipeline Runner
#
# Usage:
#   ./scripts/run-pipeline.sh scripts/relax.txt                  # full pipeline
#   ./scripts/run-pipeline.sh scripts/relax.txt --skip-generate   # reprocess only
#   ./scripts/run-pipeline.sh scripts/relax.txt --config-only     # rebuild config only
#
# Uses .venv-whisperx (Python 3.12, WhisperX forced alignment) if available,
# falls back to .venv (Python 3.14, faster-whisper).

set -e
cd "$(dirname "$0")/.."

# Prefer whisperx venv for forced alignment
if [ -f ".venv-whisperx/bin/python" ]; then
    PYTHON=".venv-whisperx/bin/python"
    echo "Using WhisperX venv (forced alignment)"
elif [ -f ".venv/bin/python" ]; then
    PYTHON=".venv/bin/python"
    echo "Using standard venv (faster-whisper)"
else
    echo "Setting up Python venv..."
    python3 -m venv .venv
    .venv/bin/pip install --quiet librosa soundfile scipy numpy faster-whisper
    PYTHON=".venv/bin/python"
    echo "Venv ready."
fi

echo ""
"$PYTHON" scripts/generate-session.py "$@"
