#!/usr/bin/env python3
"""Generate and validate live-engineer qwen-v3 catalog.

`--check-spec` never loads Qwen. Generation uses cached Qwen3 voice cloning,
deterministic per-clip seeds, PCM-16 validation, and atomic manifest writes.
"""
from __future__ import annotations
import argparse, hashlib, json, platform
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = ROOT / "scripts/live-engineer/live-engineer-v3-spec.json"
OUT = ROOT / "client/public/audio/live-engineer/qwen-v3"
WORK_DEFAULT = ROOT / ".cache/live-engineer/qwen-v3"
MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
REVISION = "fd4b254389122332181a7c3db7f27e918eec64e3"
REFERENCE = ROOT / "scripts/live-engineer/voices/Aussie-short.flac"
REFERENCE_TEXT = "G'day mate, Tom here."
GENERATION = {"language": "English", "non_streaming_mode": True, "do_sample": True, "top_k": 50, "top_p": 1.0, "temperature": 0.9, "repetition_penalty": 1.05, "subtalker_dosample": True, "subtalker_top_k": 50, "subtalker_top_p": 1.0, "subtalker_temperature": 0.9, "max_new_tokens": 128}

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def fingerprint(value: object) -> str: return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
def read_json(path: Path): return json.loads(path.read_text(encoding="utf-8"))
def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)

def integer_words(value: int) -> str:
    ones = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"]
    tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"]
    if value < 20: return ones[value]
    if value < 100: return tens[value // 10] + (f" {ones[value % 10]}" if value % 10 else "")
    return ones[value // 100] + " hundred" + (f" {integer_words(value % 100)}" if value % 100 else "")

def expand_spec(spec: dict) -> list[dict]:
    clips: list[dict] = []
    for segment_id, text in spec["fixed"]: clips.append({"id": segment_id, "text": text, "role": "fixed"})
    for segment_id, text in spec["paceTails"] + spec["opponentTails"]: clips.append({"id": segment_id, "text": text, "role": "fixed"})
    for segment_id, text in spec["raceEngineer"]: clips.append({"id": f"race-engineer.{segment_id}", "text": text, "role": "fixed"})
    for location in spec["damageLocations"]:
        clips += [{"id": f"race-engineer.damage-{location}", "text": f"You've got damage at the {location}.", "role": "fixed"}, {"id": f"race-engineer.damage-heavy-{location}", "text": f"Heavy damage at the {location}.", "role": "fixed"}]
    spotter = {"car-left":"Car left.", "car-right":"Car right.", "still-there":"Still there.", "three-wide-left":"Three wide, left.", "three-wide-right":"Three wide, right.", "clear-left":"Clear left.", "clear-right":"Clear right."}
    for state, text in spotter.items():
        if not any(item["id"] == f"spotter.{state}" for item in clips): clips.append({"id": f"spotter.{state}", "text": text, "role": "fixed"})
    for value in range(100): clips.append({"id": f"number.integer.{value}", "text": integer_words(value), "role": "continuation"})
    for value in range(1, 10): clips.append({"id": f"number.tenth.{value}", "text": f"point {integer_words(value)}", "role": "automatic"})
    for atom in spec["ranges"]["number.atom"]: clips.append({"id": f"number.atom.{atom}", "text": atom, "role": "atomic"})
    for minute in range(10):
        for second in range(60):
            text = integer_words(second) if minute == 0 else f"{integer_words(minute)} minute" + ("s" if second == 0 and minute != 1 else "" if second == 0 else f" {'oh ' if second < 10 else ''}{integer_words(second)}")
            clips.append({"id": f"lap.body.{minute}-{second:02d}", "text": text, "role": "lap-body"})
    for minute in range(10, 100): clips.append({"id": f"lap.minutes.{minute}", "text": f"{integer_words(minute)} minutes", "role": "lap-continuation"})
    for second in range(1, 60): clips.append({"id": f"lap.seconds.{second:02d}", "text": f"oh {integer_words(second)}" if second < 10 else integer_words(second), "role": "lap-continuation"})
    for value in range(1, 10): clips.append({"id": f"lap.tenth.{value}", "text": f"point {integer_words(value)}.", "role": "sentence-final"})
    return clips

def check_spec(spec: dict) -> dict:
    clips = expand_spec(spec); ids = [clip["id"] for clip in clips]
    if len(ids) != spec["expectedClipCount"]: raise SystemExit(f"spec expansion count {len(ids)} != {spec['expectedClipCount']}")
    if len(set(ids)) != len(ids): raise SystemExit("spec contains duplicate clip IDs")
    full_lines = read_json(ROOT / "shared/racing/live/full-lines.json")
    if len(full_lines) != 21: raise SystemExit(f"full-line count {len(full_lines)} != 21")
    return {"clipCount": len(ids), "fullLineCount": len(full_lines), "uniqueIds": len(ids), "catalogVersion": spec["catalogVersion"]}

def save_audio(path: Path, audio: np.ndarray, rate: int) -> dict:
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not len(audio) or not np.isfinite(audio).all() or float(np.max(np.abs(audio))) == 0 or float(np.max(np.abs(audio))) > 1: raise RuntimeError(f"invalid synthesized audio: {path}")
    path.parent.mkdir(parents=True, exist_ok=True); temporary = path.with_suffix(".tmp.flac"); sf.write(temporary, audio, rate, format="FLAC", subtype="PCM_16"); temporary.replace(path)
    return {"path": str(path.relative_to(OUT)).replace("\\", "/"), "sha256": sha256(path), "frames": len(audio), "sampleRate": rate, "durationMs": round(len(audio) * 1000 / rate)}

def synthesize(spec: dict, device: str, dtype: str, work_dir: Path) -> dict:
    import torch
    from huggingface_hub import snapshot_download
    from qwen_tts import Qwen3TTSModel
    if not torch.cuda.is_available(): raise RuntimeError("CUDA required; no CPU or synthetic fallback")
    if dtype == "bfloat16" and not torch.cuda.is_bf16_supported(): raise RuntimeError("GPU lacks bfloat16; select --dtype float16")
    snapshot = snapshot_download(MODEL, revision=REVISION, local_files_only=True)
    model = Qwen3TTSModel.from_pretrained(snapshot, device_map=device, dtype=getattr(torch, dtype), attn_implementation="sdpa", local_files_only=True)
    prompt = model.create_voice_clone_prompt(ref_audio=str(REFERENCE), ref_text=REFERENCE_TEXT, x_vector_only_mode=False)
    torch.set_num_threads(8)
    clips = []
    for index, item in enumerate(expand_spec(spec), 1):
        segment_id, text = item["id"], item["text"]; seed = int(fingerprint(segment_id)[:8], 16); destination = OUT / "chunks" / f"{segment_id}.flac"
        metadata_path = work_dir / "clips" / f"{segment_id}.json"; old = read_json(metadata_path) if metadata_path.is_file() else {}
        if old.get("text") == text and old.get("sha256") and destination.is_file() and sha256(destination) == old["sha256"]:
            record = old
        else:
            print(f"synthesizing clip {index}/{len(expand_spec(spec))}: {segment_id}", flush=True)
            torch.manual_seed(seed); torch.cuda.manual_seed_all(seed)
            with torch.inference_mode(): wavs, rate = model.generate_voice_clone(text=text, voice_clone_prompt=prompt, **GENERATION)
            if len(wavs) != 1: raise RuntimeError(f"expected one waveform: {segment_id}")
            record = {"segmentId": segment_id, "spokenText": text, "seed": seed, **save_audio(destination, np.asarray(wavs[0]), rate), "sourceTranscript": text, "sourceHash": fingerprint(text), "role": item["role"]}
            write_json(metadata_path, record)
        clips.append(record)
        if index % 100 == 0: print(f"generated {index}/{len(expand_spec(spec))}", flush=True)
    existing_manifest_path = OUT / "manifest.json"
    existing_manifest = read_json(existing_manifest_path) if existing_manifest_path.is_file() else {}
    existing_full_lines = {line["lineId"]: line for line in existing_manifest.get("fullLines", [])}
    full_lines = []
    for line in read_json(ROOT / "shared/racing/live/full-lines.json"):
        line_id, text = line["lineId"], line["spokenText"]; seed = int(fingerprint(f"full/{line_id}")[:8], 16); destination = OUT / "full" / f"{line_id}.flac"
        old = existing_full_lines.get(line_id, {})
        if old.get("spokenText") == text and old.get("sha256") and destination.is_file() and sha256(destination) == old["sha256"]:
            record = old
        else:
            torch.manual_seed(seed); torch.cuda.manual_seed_all(seed)
            with torch.inference_mode(): wavs, rate = model.generate_voice_clone(text=text, voice_clone_prompt=prompt, **GENERATION)
            if len(wavs) != 1: raise RuntimeError(f"expected one full-line waveform: {line_id}")
            record = {"lineId": line_id, "spokenText": text, **save_audio(destination, np.asarray(wavs[0]), rate), "sourceTranscript": text, "seed": seed}
        full_lines.append(record)
    del prompt, model; gc = getattr(torch.cuda, "empty_cache", None); gc and gc()
    oracle_by_line = {line["lineId"]: {"oracleId": f"oracle.{line['lineId']}", "text": line["spokenText"], "path": line["path"], "sha256": line["sha256"], "durationMs": line["durationMs"], "recipeSegmentIds": []} for line in full_lines}
    recipes = [{"approvalId": f"full-line.{line['lineId']}", "mode": "automatic", "scopeOrDirection": line["lineId"], "segmentIds": [], "oracleId": f"oracle.{line['lineId']}", "status": "not-listened"} for line in full_lines]
    manifest = {"catalogVersion": spec["catalogVersion"], "model": MODEL, "modelRevision": REVISION, "sampleRate": clips[0]["sampleRate"], "channels": 1, "format": "FLAC PCM_16", "listeningStatus": "not-listened", "approvals": {"fixed": {clip["segmentId"]: "not-listened" for clip in clips if clip["role"] == "fixed"}, "recipes": recipes}, "assembly": {"mode": "exact-buffer", "gapMs": 0, "edgeFadeMs": 3}, "referenceText": REFERENCE_TEXT, "referenceSha256": sha256(REFERENCE), "sampleSpecification": str(SPEC_PATH.relative_to(ROOT)).replace("\\", "/"), "specificationSha256": sha256(SPEC_PATH), "generator": str(Path(__file__).relative_to(ROOT)).replace("\\", "/"), "generatorSha256": sha256(Path(__file__)), "clips": clips, "fullLines": full_lines, "oracles": list(oracle_by_line.values())}
    write_json(OUT / "manifest.json", manifest); return {"clipCount": len(clips), "fullLineCount": len(full_lines), "generated": True}

def check_catalog(spec: dict) -> dict:
    manifest = read_json(OUT / "manifest.json"); expected = {clip["id"] for clip in expand_spec(spec)}; actual = {clip.get("segmentId") for clip in manifest.get("clips", [])}
    missing = expected - actual
    if missing: raise SystemExit(f"manifest missing {len(missing)} clips; first {sorted(missing)[0]}")
    if manifest.get("catalogVersion") != spec["catalogVersion"]: raise SystemExit("catalog version mismatch")
    for clip in manifest["clips"]:
        path = OUT / clip["path"]
        if not path.is_file() or sha256(path) != clip.get("sha256") or clip.get("sampleRate") != 24000 or clip.get("frames", 0) <= 0: raise SystemExit(f"invalid asset: {clip['segmentId']}")
    return {"clipCount": len(actual), "fullLineCount": len(manifest.get("fullLines", [])), "catalogVersion": manifest["catalogVersion"]}

def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--check-spec", action="store_true"); parser.add_argument("--check", action="store_true"); parser.add_argument("--work-dir", type=Path, default=WORK_DEFAULT); parser.add_argument("--device", default="cuda:0"); parser.add_argument("--dtype", choices=("bfloat16", "float16"), default="bfloat16"); args = parser.parse_args(); spec = read_json(SPEC_PATH)
    if args.check_spec: print(json.dumps(check_spec(spec), sort_keys=True)); return
    if args.check: print(json.dumps(check_catalog(spec), sort_keys=True)); return
    print(json.dumps(synthesize(spec, args.device, args.dtype, args.work_dir), sort_keys=True))
if __name__ == "__main__": main()
