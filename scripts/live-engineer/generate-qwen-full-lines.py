#!/usr/bin/env python3
"""Generate complete Live Engineer lines with Qwen3-TTS.

This generates Qwen full-line and atomic clip catalogs. Install qwen-tts
in a separate environment before running:
  python -m pip install -U qwen-tts
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "client/public/audio/live-engineer/qwen-v1"
DEFAULT_REFERENCE = ROOT / "scripts/live-engineer/voices/Aussie-short.flac"
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
REFERENCE_TEXT = "G'day mate, Tom here."

FULL_LINES = (
    ("fastest-class", "Fastest in class."),
    ("fastest-overall", "Fastest overall."),
    ("setting-race-pace", "You are setting the current race pace."),
    ("within-class-pace", "You are point three seconds from class pace."),
    ("within-overall-pace", "You are point three seconds from overall pace."),
    ("off-class-pace", "You are point three seconds off class pace."),
    ("off-overall-pace", "You are point three seconds off overall pace."),
    ("outlier-class", "That lap is point three seconds off class pace."),
    ("outlier-overall", "That lap is point three seconds off overall pace."),
    ("lap-time", "Your lap was one minute thirty two point four one seven."),
    ("car-left", "Car left."),
    ("car-right", "Car right."),
    ("still-there", "Still there."),
    ("clear-left", "Clear left."),
    ("clear-right", "Clear right."),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, default=DEFAULT_REFERENCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--dtype", choices=("bfloat16", "float16"), default="bfloat16")
    parser.add_argument("--no-flash-attention", action="store_true")
    parser.add_argument("--batch-size", type=int, default=8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as exc:
        raise SystemExit(f"Missing Qwen dependencies: {exc}. Install qwen-tts in a separate environment.") from exc

    if not args.reference.is_file():
        raise SystemExit(f"Missing reference audio: {args.reference}")
    args.output.mkdir(parents=True, exist_ok=True)
    dtype = torch.bfloat16 if args.dtype == "bfloat16" else torch.float16
    model_kwargs = {"device_map": args.device, "dtype": dtype}
    if not args.no_flash_attention:
        model_kwargs["attn_implementation"] = "flash_attention_2"
    model = Qwen3TTSModel.from_pretrained(MODEL_ID, **model_kwargs)
    source_manifest = args.output / "manifest.json"
    if not source_manifest.is_file():
        raise SystemExit(f"Missing existing Qwen catalog: {source_manifest}")
    source_clips = json.loads(source_manifest.read_text()).get("clips", [])
    lines = []
    full_wavs, sample_rate = model.generate_voice_clone(
        text=[text for _, text in FULL_LINES],
        language=["English"] * len(FULL_LINES),
        ref_audio=[str(args.reference)] * len(FULL_LINES),
        ref_text=[REFERENCE_TEXT] * len(FULL_LINES),
    )
    for (line_id, spoken_text), wav in zip(FULL_LINES, full_wavs):
        path = args.output / f"full__{line_id}.wav"
        audio = np.asarray(wav).reshape(-1)
        sf.write(path, audio, sample_rate, format="WAV", subtype="PCM_16")
        lines.append({"lineId": line_id, "spokenText": spoken_text, "path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "durationMs": round(1000 * len(audio) / sample_rate)})
    clips = []
    for start in range(0, len(source_clips), args.batch_size):
        batch = source_clips[start:start + args.batch_size]
        print(f"Generating Qwen clips {start + 1}-{start + len(batch)} of {len(source_clips)}")
        wavs, _ = model.generate_voice_clone(
            text=[clip["spokenText"] for clip in batch],
            language=["English"] * len(batch),
            ref_audio=[str(args.reference)] * len(batch),
            ref_text=[REFERENCE_TEXT] * len(batch),
        )
        for clip, wav in zip(batch, wavs):
            path = args.output / f"clip__{clip['segmentId'].replace('.', '__')}.wav"
            audio = np.asarray(wav).reshape(-1)
            sf.write(path, audio, sample_rate, format="WAV", subtype="PCM_16")
            clips.append({"segmentId": clip["segmentId"], "spokenText": clip["spokenText"], "path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "durationMs": round(1000 * len(audio) / sample_rate)})
    manifest = {
        "catalogVersion": "live-engineer-qwen-v1",
        "model": MODEL_ID,
        "sampleRate": sample_rate,
        "channels": 1,
        "referenceAudio": str(args.reference.relative_to(ROOT)),
        "referenceText": REFERENCE_TEXT,
        "fullLines": lines,
        "clips": clips,
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"model": MODEL_ID, "lineCount": len(lines), "clipCount": len(clips), "output": str(args.output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
