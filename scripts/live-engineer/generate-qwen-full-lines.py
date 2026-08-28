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
    ("opponent-faster-last-lap", "Opponent was point three seconds faster last lap."),
    ("driver-faster-last-lap", "You were point three seconds faster last lap."),
    ("tires-cold", "Tires are cold. Be careful."),
    ("tires-optimal", "Tires are optimal."),
    ("pit-this-lap", "Pit this lap."),
    ("pit-pit-pit", "Pit pit pit."),
    ("car-left", "Car left."),
    ("car-right", "Car right."),
    ("still-there", "Still there."),
    ("clear-left", "Clear left."),
    ("clear-right", "Clear right."),
)
EXTRA_CLIPS = (
    {"segmentId": "phrase.opponent-was", "spokenText": "Opponent was", "path": "clip__phrase__opponent-was.wav"},
    {"segmentId": "phrase.you-were", "spokenText": "You were", "path": "clip__phrase__you-were.wav"},
    {"segmentId": "phrase.faster-last-lap", "spokenText": "faster last lap.", "path": "clip__phrase__faster-last-lap.wav"},
    {"segmentId": "phrase.same-pace-last-lap", "spokenText": "Same pace as opponent last lap.", "path": "clip__phrase__same-pace-last-lap.wav"},
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
    reference = args.reference.resolve()
    try:
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
    except ImportError as exc:
        raise SystemExit(f"Missing Qwen dependencies: {exc}") from exc
    if not reference.is_file():
        raise SystemExit(f"Missing reference audio: {reference}")
    args.output.mkdir(parents=True, exist_ok=True)
    source_manifest = args.output / "manifest.json"
    if not source_manifest.is_file():
        raise SystemExit(f"Missing existing Qwen catalog: {source_manifest}")
    existing = json.loads(source_manifest.read_text())
    old_lines = {line["lineId"]: line for line in existing.get("fullLines", [])}
    old_clips = {clip["segmentId"]: clip for clip in existing.get("clips", [])}
    source_clips = list(old_clips.values())
    source_clips.extend(clip for clip in EXTRA_CLIPS if clip["segmentId"] not in old_clips)
    missing_lines = [(line_id, text) for line_id, text in FULL_LINES if not (old_lines.get(line_id) and (args.output / old_lines[line_id]["path"]).is_file())]
    missing_clips = [clip for clip in source_clips if not (args.output / clip["path"]).is_file()]
    model = None
    sample_rate = int(existing.get("sampleRate", 24000))
    if missing_lines or missing_clips:
        dtype = torch.bfloat16 if args.dtype == "bfloat16" else torch.float16
        model_kwargs = {"device_map": args.device, "dtype": dtype}
        if not args.no_flash_attention:
            model_kwargs["attn_implementation"] = "flash_attention_2"
        model = Qwen3TTSModel.from_pretrained(MODEL_ID, **model_kwargs)
    lines = [old_lines[line_id] for line_id, _ in FULL_LINES if line_id in old_lines and (args.output / old_lines[line_id]["path"]).is_file()]
    if missing_lines:
        wavs, sample_rate = model.generate_voice_clone(text=[text for _, text in missing_lines], language=["English"] * len(missing_lines), ref_audio=[str(reference)] * len(missing_lines), ref_text=[REFERENCE_TEXT] * len(missing_lines))
        for (line_id, spoken_text), wav in zip(missing_lines, wavs):
            path = args.output / f"full__{line_id}.wav"
            audio = np.asarray(wav).reshape(-1)
            sf.write(path, audio, sample_rate, format="WAV", subtype="PCM_16")
            lines.append({"lineId": line_id, "spokenText": spoken_text, "path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "durationMs": round(1000 * len(audio) / sample_rate)})
    lines.sort(key=lambda line: next(index for index, (line_id, _) in enumerate(FULL_LINES) if line_id == line["lineId"]))
    clips = [old_clips[clip["segmentId"]] for clip in source_clips if clip["segmentId"] in old_clips and (args.output / old_clips[clip["segmentId"]]["path"]).is_file()]
    for start in range(0, len(missing_clips), args.batch_size):
        batch = missing_clips[start:start + args.batch_size]
        print(f"Generating Qwen clips {start + 1}-{start + len(batch)} of {len(missing_clips)}")
        wavs, sample_rate = model.generate_voice_clone(text=[clip["spokenText"] for clip in batch], language=["English"] * len(batch), ref_audio=[str(reference)] * len(batch), ref_text=[REFERENCE_TEXT] * len(batch))
        for clip, wav in zip(batch, wavs):
            path = args.output / clip["path"]
            audio = np.asarray(wav).reshape(-1)
            sf.write(path, audio, sample_rate, format="WAV", subtype="PCM_16")
            clips.append({"segmentId": clip["segmentId"], "spokenText": clip["spokenText"], "path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "durationMs": round(1000 * len(audio) / sample_rate)})
    clips.sort(key=lambda clip: source_clips.index(next(source for source in source_clips if source["segmentId"] == clip["segmentId"])))
    manifest = {**existing, "catalogVersion": "live-engineer-qwen-v1", "model": MODEL_ID, "sampleRate": sample_rate, "channels": 1, "referenceAudio": str(reference.relative_to(ROOT)), "referenceText": REFERENCE_TEXT, "fullLines": lines, "clips": clips}
    source_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"model": MODEL_ID, "lineCount": len(lines), "clipCount": len(clips), "generatedLines": len(missing_lines), "generatedClips": len(missing_clips), "output": str(args.output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
