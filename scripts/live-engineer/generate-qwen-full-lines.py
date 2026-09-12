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
FULL_LINES = tuple((entry["lineId"], entry["spokenText"]) for entry in json.loads((ROOT / "shared/racing/live/full-lines.json").read_text()))
REFERENCE_TEXT = "G'day mate, Tom here."

EXTRA_CLIPS = (
    {"segmentId": "phrase.opponent-was", "spokenText": "Opponent was", "path": "clip__phrase__opponent-was.wav"},
    {"segmentId": "phrase.you-were", "spokenText": "You were", "path": "clip__phrase__you-were.wav"},
    {"segmentId": "phrase.faster-last-lap", "spokenText": "faster last lap.", "path": "clip__phrase__faster-last-lap.wav"},
    {"segmentId": "phrase.same-pace-last-lap", "spokenText": "Same pace as opponent last lap.", "path": "clip__phrase__same-pace-last-lap.wav"},
    {"segmentId": "race-engineer.position-changed", "spokenText": "Position changed.", "path": "clip__race-engineer__position-changed.wav"},
    {"segmentId": "race-engineer.pre-lights", "spokenText": "Get ready for the start.", "path": "clip__race-engineer__pre-lights.wav"},
    {"segmentId": "race-engineer.green-flag", "spokenText": "Green flag.", "path": "clip__race-engineer__green-flag.wav"},
    {"segmentId": "race-engineer.lap-completed", "spokenText": "Lap completed.", "path": "clip__race-engineer__lap-completed.wav"},
    {"segmentId": "race-engineer.lap-invalidated", "spokenText": "Lap invalidated.", "path": "clip__race-engineer__lap-invalidated.wav"},
    {"segmentId": "race-engineer.opponent-lap-completed", "spokenText": "Opponent lap completed.", "path": "clip__race-engineer__opponent-lap-completed.wav"},
    {"segmentId": "race-engineer.multiclass-traffic", "spokenText": "Multiclass traffic ahead.", "path": "clip__race-engineer__multiclass-traffic.wav"},
    {"segmentId": "race-engineer.penalty-issued", "spokenText": "Penalty issued.", "path": "clip__race-engineer__penalty-issued.wav"},
    {"segmentId": "race-engineer.pit-entry", "spokenText": "Pit entry.", "path": "clip__race-engineer__pit-entry.wav"},
    {"segmentId": "race-engineer.pit-exit", "spokenText": "Pit exit.", "path": "clip__race-engineer__pit-exit.wav"},
    {"segmentId": "race-engineer.fuel-low", "spokenText": "Fuel is low.", "path": "clip__race-engineer__fuel-low.wav"},
    {"segmentId": "race-engineer.fuel-critical", "spokenText": "Fuel is critical.", "path": "clip__race-engineer__fuel-critical.wav"},
    {"segmentId": "race-engineer.flag-change", "spokenText": "Flag changed.", "path": "clip__race-engineer__flag-change.wav"},
    {"segmentId": "race-engineer.black-flag", "spokenText": "Black flag. Black flag.", "path": "clip__race-engineer__black-flag.wav"},
    {"segmentId": "race-engineer.blue-flag", "spokenText": "Blue flag.", "path": "clip__race-engineer__blue-flag.wav"},
    {"segmentId": "race-engineer.tyres-cold", "spokenText": "Tires are cold.", "path": "clip__race-engineer__tyres-cold.wav"},
    {"segmentId": "race-engineer.tyres-hot", "spokenText": "Tires are hot.", "path": "clip__race-engineer__tyres-hot.wav"},
    {"segmentId": "race-engineer.tyres-cooking", "spokenText": "Tires are overheating.", "path": "clip__race-engineer__tyres-cooking.wav"},
    {"segmentId": "race-engineer.water-temperature-hot", "spokenText": "Water temperature is high.", "path": "clip__race-engineer__water-temperature-hot.wav"},
    {"segmentId": "race-engineer.damage-front", "spokenText": "You've got damage at the front.", "path": "clip__race-engineer__damage-front.wav"},
    {"segmentId": "race-engineer.damage-rear", "spokenText": "You've got damage at the rear.", "path": "clip__race-engineer__damage-rear.wav"},
    {"segmentId": "race-engineer.damage-left", "spokenText": "You've got damage on the left.", "path": "clip__race-engineer__damage-left.wav"},
    {"segmentId": "race-engineer.damage-right", "spokenText": "You've got damage on the right.", "path": "clip__race-engineer__damage-right.wav"},
    {"segmentId": "race-engineer.damage-centre", "spokenText": "You've got damage in the centre.", "path": "clip__race-engineer__damage-centre.wav"},
    {"segmentId": "race-engineer.damage-heavy-front", "spokenText": "Heavy damage at the front.", "path": "clip__race-engineer__damage-heavy-front.wav"},
    {"segmentId": "race-engineer.damage-heavy-rear", "spokenText": "Heavy damage at the rear.", "path": "clip__race-engineer__damage-heavy-rear.wav"},
    {"segmentId": "race-engineer.damage-heavy-left", "spokenText": "Heavy damage on the left.", "path": "clip__race-engineer__damage-heavy-left.wav"},
    {"segmentId": "race-engineer.damage-heavy-right", "spokenText": "Heavy damage on the right.", "path": "clip__race-engineer__damage-heavy-right.wav"},
    {"segmentId": "race-engineer.damage-heavy-centre", "spokenText": "Heavy damage in the centre.", "path": "clip__race-engineer__damage-heavy-centre.wav"},
    {"segmentId": "race-engineer.water-temperature-clear", "spokenText": "Water temperature is clear.", "path": "clip__race-engineer__water-temperature-clear.wav"},
    {"segmentId": "race-engineer.damage-reported", "spokenText": "Damage reported.", "path": "clip__race-engineer__damage-reported.wav"},
    {"segmentId": "race-engineer.rain-changed", "spokenText": "Rain conditions changed.", "path": "clip__race-engineer__rain-changed.wav"},
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
    manifest = {**existing, "catalogVersion": f"live-engineer-{args.output.name}", "model": MODEL_ID, "sampleRate": sample_rate, "channels": 1, "referenceAudio": str(reference.relative_to(ROOT)), "referenceText": REFERENCE_TEXT, "fullLines": lines, "clips": clips}
    source_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"model": MODEL_ID, "lineCount": len(lines), "clipCount": len(clips), "generatedLines": len(missing_lines), "generatedClips": len(missing_clips), "output": str(args.output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
