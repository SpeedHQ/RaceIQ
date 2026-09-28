#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT_DIR="$ROOT_DIR/scripts/live-engineer"
VENV_DIR="${QWEN_VENV_DIR:-$SCRIPT_DIR/.venv}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REFERENCE="$SCRIPT_DIR/voices/Aussie-short.flac"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  printf 'Python executable not found: %s\n' "$PYTHON_BIN" >&2
  exit 1
fi

"$PYTHON_BIN" -c 'import sys; sys.exit("Python 3.11+ required") if sys.version_info < (3, 11) else None'

if ! command -v sox >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    printf 'Installing SoX system dependency...\n'
    brew install sox
  else
    printf 'SoX is required but neither SoX nor Homebrew was found.\n' >&2
    exit 1
  fi
fi

if [[ ! -f "$REFERENCE" ]]; then
  printf 'Missing reference voice: %s\n' "$REFERENCE" >&2
  exit 1
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  printf 'Creating Qwen virtual environment: %s\n' "$VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

PYTHON="$VENV_DIR/bin/python"
printf 'Installing Qwen TTS dependencies...\n'
"$PYTHON" -m pip install --upgrade pip
"$PYTHON" -m pip install -r "$SCRIPT_DIR/requirements.lock" qwen-tts

printf 'Validating Qwen environment...\n'
"$PYTHON" - <<'PY'
import numpy
import soundfile
import torch
import qwen_tts

print(f"Python: {__import__('sys').version.split()[0]}")
print(f"Torch: {torch.__version__}")
print(f"Qwen TTS: {qwen_tts.__file__}")
print(f"MPS available: {bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available())}")
PY

printf '\nEnvironment ready.\n'
printf 'Reference: %s\n' "$REFERENCE"
printf 'Generate clips:\n'
printf '  %q scripts/live-engineer/generate-qwen-full-lines.py --reference %q --output client/public/audio/live-engineer/qwen-v1 --device mps\n' "$PYTHON" "$REFERENCE"
