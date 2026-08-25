#!/usr/bin/env python3
"""Generate deterministic Live Engineer phrase and number clips with OmniVoice.

Usage:
  python scripts/live-engineer/generate.py --render --validate --ref-audio /path/ref.wav --ref-text '...'
  python scripts/live-engineer/generate.py --check
"""
from __future__ import annotations
import argparse, hashlib, json, math, os, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "client/public/audio/live-engineer/v1"
MANIFEST = OUT / "manifest.json"
CATALOG_TS = ROOT / "shared/racing/live/engineer-audio-catalog.generated.ts"
REPORT = Path(__file__).with_name("validation-report.json")
PIPELINE_VERSION = "live-engineer-omnivoice-v1"
CATALOG_VERSION = "live-engineer-v1"
SAMPLE_RATE = 24000
INSTRUCT = "male, Australian accent"
DEFAULT_REF_AUDIO = Path(__file__).with_name("voices") / "Aussie-medium.flac"
LANGUAGE = "en"
SPEED = 1.35
NUM_STEPS = 32
SPEED_OVERRIDES: dict[str, float] = {}
SEED_OVERRIDES: dict[str, int] = {}
INSTRUCT_OVERRIDES = {
    "phrase.within-class-pace": "male, Australian accent, low pitch",
    "phrase.off-class-pace": "male, Australian accent, low pitch",
}
SYNTHESIS_TEXT_OVERRIDES: dict[str, str] = {}

def synthesis_text(segment_id: str, spoken: str) -> str:
    text = SYNTHESIS_TEXT_OVERRIDES.get(segment_id, spoken).strip()
    if not text:
        return text
    if text[-1] not in ".!?":
        text += "."
    return text[0].upper() + text[1:]
TRIM_PADDING_MS = 5
JOIN_GAP_MS = -20
SEED = int(os.environ.get("LIVE_ENGINEER_SEED", "46"))

PHRASES = {
    "phrase.fastest.class": "Fastest in class.",
    "phrase.fastest.overall": "Fastest overall.",
    "phrase.setting-race-pace": "You are setting the current race pace.",
    "phrase.within-class-pace": "You are",
    "phrase.off-class-pace": "You are",
    "phrase.outlier-lap": "That lap is",
    "phrase.scope.class": "class pace.",
    "phrase.scope.overall": "overall pace.",
    "phrase.from": "from",
    "phrase.off": "off",
    "phrase.exact.intro": "The pace is",
    "phrase.exact.your-lap": "Your lap was",
    "spotter.car-left": "Car left.",
    "spotter.car-right": "Car right.",
    "spotter.still-there": "Still there.",
    "spotter.three-wide-left": "Three wide, left.",
    "spotter.three-wide-right": "Three wide, right.",
    "spotter.clear-left": "Clear left.",
    "spotter.clear-right": "Clear right.",
    "unit.second": "second",
    "unit.seconds": "seconds",
    "unit.minute": "minute",
    "unit.minutes": "minutes",
    "unit.point": "point",
}
ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
DIGIT_WORDS = {str(i): word for i, word in enumerate(ONES)}

def number_words(value: int) -> list[str]:
    if value < 20: return [ONES[value]]
    if value < 100: return [TENS[value // 10]] + ([] if value % 10 == 0 else [ONES[value % 10]])
    return [ONES[value // 100], "hundred"] + ([] if value % 100 == 0 else number_words(value % 100))

def catalog() -> dict[str, str]:
    clips = dict(PHRASES)
    for i, word in enumerate(ONES): clips[f"number.{word}"] = word
    for i in range(2, 10): clips[f"number.{TENS[i]}"] = TENS[i]
    clips["number.hundred"] = "hundred"
    clips["number.point"] = "point"
    return clips

def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def input_hash(ref_audio: Path, ref_text: str) -> str:
    h = hashlib.sha256(); h.update(PIPELINE_VERSION.encode()); h.update(ref_audio.read_bytes()); h.update(ref_text.encode()); h.update(json.dumps({"seed": SEED, "seedOverrides": SEED_OVERRIDES, "speed": SPEED, "speedOverrides": SPEED_OVERRIDES, "instruct": INSTRUCT, "instructOverrides": INSTRUCT_OVERRIDES, "synthesisTextOverrides": SYNTHESIS_TEXT_OVERRIDES, "sampleRate": SAMPLE_RATE, "trimPaddingMs": TRIM_PADDING_MS, "joinGapMs": JOIN_GAP_MS}, sort_keys=True).encode()); return h.hexdigest()

def trim_normalize(audio, pad: int = int(SAMPLE_RATE * TRIM_PADDING_MS / 1000)):
    import numpy as np
    audio = np.asarray(audio, dtype="float32").reshape(-1)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak <= 1e-8: raise ValueError("silent clip")
    threshold = max(0.003, peak * 0.025)
    active = np.flatnonzero(np.abs(audio) >= threshold)
    if active.size: audio = audio[max(0, int(active[0]) - pad): min(len(audio), int(active[-1]) + pad + 1)]
    rms = math.sqrt(float(np.mean(audio * audio)))
    if rms > 1e-8: audio *= 10 ** ((-20.0 - 20 * math.log10(rms)) / 20)
    peak = float(np.max(np.abs(audio)))
    if peak > 10 ** (-1 / 20): audio *= (10 ** (-1 / 20)) / peak
    return audio.astype("float32")

def render(args) -> int:
    try:
        import numpy as np, soundfile as sf, torch
        from omnivoice import OmniVoice, OmniVoiceGenerationConfig
    except ImportError as exc:
        print(f"missing OmniVoice dependencies: {exc}", file=sys.stderr); return 2
    ref = Path(args.ref_audio).expanduser()
    if not ref.is_file(): print(f"missing reference audio: {ref}", file=sys.stderr); return 2
    torch.manual_seed(SEED); np.random.seed(SEED)
    device = "mps" if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device != "cpu" else torch.float32
    print(f"OmniVoice device={device} model=k2-fsa/OmniVoice")
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=device, dtype=dtype)
    validation_model = None
    if args.validate:
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            print(f"missing faster-whisper dependencies: {exc}", file=sys.stderr); return 2
        validation_model = WhisperModel("base.en", device="cpu", compute_type="int8")
    OUT.mkdir(parents=True, exist_ok=True); entries = json.loads(MANIFEST.read_text()).get("clips", []) if args.segment and MANIFEST.exists() else []
    if args.segment:
        entries = [entry for entry in entries if entry.get("segmentId") != args.segment]
    source_hash = input_hash(ref, args.ref_text)
    def write_catalog_ts() -> None:
        payload = json.dumps([{"segmentId": e["segmentId"], "url": f"/audio/live-engineer/v1/{e['path']}", "sha256": e["sha256"], "durationMs": e["durationMs"]} for e in entries], indent=2)
        CATALOG_TS.write_text(f"export const LIVE_ENGINEER_AUDIO_CATALOG_VERSION = {CATALOG_VERSION!r} as const;\nexport const LIVE_ENGINEER_AUDIO_CATALOG = {{ catalogVersion: LIVE_ENGINEER_AUDIO_CATALOG_VERSION, sampleRate: 24000, channels: 1, joinGapMs: {JOIN_GAP_MS}, segments: {payload} as const }};\nexport type LiveEngineerAudioSegment = (typeof LIVE_ENGINEER_AUDIO_CATALOG.segments)[number];\n")
    def write_manifest() -> None:
        MANIFEST.write_text(json.dumps({"catalogVersion": CATALOG_VERSION, "pipelineVersion": PIPELINE_VERSION, "sampleRate": SAMPLE_RATE, "channels": 1, "joinGapMs": JOIN_GAP_MS, "speed": SPEED, "trimPaddingMs": TRIM_PADDING_MS, "sourceHash": source_hash, "clips": entries}, indent=2) + "\n")
        write_catalog_ts()
    pending: list[tuple[str, str, Path, str]] = []
    for segment_id, spoken in catalog().items():
        if args.segment and segment_id != args.segment: continue
        safe = segment_id.replace(".", "__")
        target = OUT / f"{safe}.flac"
        clip_hash = hashlib.sha256(f"{source_hash}:{segment_id}:{spoken}".encode()).hexdigest()
        if target.exists() and not args.force:
            entries.append({"segmentId": segment_id, "spokenText": spoken, "path": target.name, "sha256": sha256_file(target), "durationMs": round(1000 * sf.info(target).duration), "contentHash": clip_hash}); write_manifest(); continue
        pending.append((segment_id, spoken, target, clip_hash))
    for index, (segment_id, spoken, target, clip_hash) in enumerate(pending, start=1):
        print(f"generating clip {index}/{len(pending)}: {segment_id}")
        base_seed = SEED_OVERRIDES.get(segment_id, SEED)
        attempts = 12 if validation_model is not None else 1
        audio = None
        for attempt in range(attempts):
            torch.manual_seed(base_seed + attempt); np.random.seed(base_seed + attempt)
            generated = model.generate(
                text=[synthesis_text(segment_id, spoken)],
                language=[LANGUAGE],
                ref_audio=[str(ref)],
                ref_text=[args.ref_text],
                instruct=[INSTRUCT_OVERRIDES.get(segment_id, INSTRUCT)],
                speed=[SPEED_OVERRIDES.get(segment_id, SPEED)],
                generation_config=OmniVoiceGenerationConfig(num_step=NUM_STEPS),
            )
            audio = trim_normalize(generated[0])
            candidate = target.with_name(f"{target.stem}.attempt-{attempt}{target.suffix}")
            sf.write(str(candidate), audio, SAMPLE_RATE, format="FLAC", subtype="PCM_16")
            if validation_model is None:
                os.replace(candidate, target)
                break
            segments, _ = validation_model.transcribe(
                str(candidate),
                language="en",
                beam_size=5,
                condition_on_previous_text=False,
                temperature=0,
                word_timestamps=True,
            )
            transcript = " ".join(segment.text for segment in segments).strip()
            failure = validate_transcript(segment_id, transcript, spoken)
            if failure is None:
                first_word = next((word for segment in segments for word in (segment.words or []) if word.word.strip()), None)
                if first_word is not None:
                    onset_failure = validate_pre_speech_energy(audio, first_word.start)
                    if onset_failure is not None:
                        onset = max(0, round(first_word.start * SAMPLE_RATE))
                        audio = trim_normalize(audio[onset:])
                        sf.write(str(candidate), audio, SAMPLE_RATE, format="FLAC", subtype="PCM_16")
            if failure is None or attempt == attempts - 1:
                os.replace(candidate, target)
                if failure is not None:
                    print(f"  final failed validation: {failure}; whisper={transcript!r}", file=sys.stderr)
                break
            candidate.unlink(missing_ok=True)
            print(f"  retry {attempt + 1}/{attempts}: {failure}; whisper={transcript!r}", file=sys.stderr)
        entries.append({"segmentId": segment_id, "spokenText": spoken, "path": target.name, "sha256": sha256_file(target), "durationMs": round(1000 * len(audio) / SAMPLE_RATE), "contentHash": clip_hash})
        write_manifest()
    print(f"wrote {len(entries)} clips to {OUT}")
    if args.validate:
        failures = validate_audio_catalog()
        REPORT.write_text(json.dumps({"pipelineVersion": PIPELINE_VERSION, "catalogVersion": CATALOG_VERSION, "passed": not failures, "failures": failures}, indent=2) + "\n")
        if failures:
            print("\n".join(failures), file=sys.stderr)
            return 1
    return 0
def _canonical_tokens(text: str) -> list[str]:
    number_aliases = {word: str(index) for index, word in enumerate(ONES)}
    number_aliases.update({TENS[index]: str(index * 10) for index in range(2, 10)})
    number_aliases["hundred"] = "100"
    return [number_aliases.get(token, token) for token in re.findall(r"[a-z']+|\d+", text.lower())]


def validate_pre_speech_energy(audio, first_word_start_s: float, sample_rate: int = SAMPLE_RATE) -> str | None:
    import numpy as np
    audio = np.asarray(audio, dtype="float32").reshape(-1)
    prefix_end = max(0, min(len(audio), round(first_word_start_s * sample_rate)))
    if prefix_end == 0:
        return None
    prefix = audio[:prefix_end]
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    threshold = max(0.003, peak * 0.025)
    prefix_rms = math.sqrt(float(np.mean(prefix * prefix))) if prefix.size else 0.0
    full_rms = math.sqrt(float(np.mean(audio * audio))) if audio.size else 0.0
    if np.any(np.abs(prefix) >= threshold) and prefix_rms >= max(0.003, full_rms * 0.2):
        return f"pre-speech voiced energy before {first_word_start_s:.3f}s"
    return None

def validate_transcript(segment_id: str, transcript: str, expected: str) -> str | None:
    actual_tokens = _canonical_tokens(transcript)
    expected_tokens = _canonical_tokens(expected)
    if actual_tokens == expected_tokens:
        return None
    return f"{segment_id}: transcript mismatch; expected {expected_tokens}, got {actual_tokens}"

def validate_audio_catalog() -> list[str]:
    try:
        from faster_whisper import WhisperModel
        import soundfile as sf
    except ImportError as exc:
        return [f"missing validation dependency: {exc}"]
    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    failures: list[str] = []
    manifest = json.loads(MANIFEST.read_text())
    for clip in manifest.get("clips", []):
        audio, sample_rate = sf.read(str(OUT / clip["path"]), dtype="float32")
        segments, _ = model.transcribe(
            str(OUT / clip["path"]),
            language="en",
            beam_size=5,
            condition_on_previous_text=False,
            temperature=0,
            word_timestamps=True,
        )
        segments = list(segments)
        transcript = " ".join(segment.text for segment in segments).strip()
        failure = validate_transcript(clip["segmentId"], transcript, clip["spokenText"])
        if failure is None:
            first_word = next((word for segment in segments for word in (segment.words or []) if word.word.strip()), None)
            if first_word is not None:
                failure = validate_pre_speech_energy(audio, first_word.start, sample_rate)
        if failure:
            failures.append(f"{failure}; whisper={transcript!r}")
    return failures

def trim_existing_catalog() -> int:
    import soundfile as sf
    if not MANIFEST.exists(): print("missing manifest", file=sys.stderr); return 1
    manifest = json.loads(MANIFEST.read_text())
    for clip in manifest.get("clips", []):
        path = OUT / clip["path"]
        audio, sample_rate = sf.read(str(path), dtype="float32")
        if sample_rate != SAMPLE_RATE: raise ValueError(f"{path}: unexpected sample rate {sample_rate}")
        audio = trim_normalize(audio)
        sf.write(str(path), audio, SAMPLE_RATE, format="FLAC", subtype="PCM_16")
        clip["sha256"] = sha256_file(path); clip["durationMs"] = round(1000 * len(audio) / SAMPLE_RATE)
    manifest.update({"pipelineVersion": PIPELINE_VERSION, "joinGapMs": JOIN_GAP_MS, "speed": SPEED, "trimPaddingMs": TRIM_PADDING_MS})
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    segments = [{"segmentId": c["segmentId"], "url": f"/audio/live-engineer/v1/{c['path']}", "sha256": c["sha256"], "durationMs": c["durationMs"]} for c in manifest["clips"]]
    CATALOG_TS.write_text("export const LIVE_ENGINEER_AUDIO_CATALOG_VERSION = 'live-engineer-v1' as const;\nexport const LIVE_ENGINEER_AUDIO_CATALOG = " + json.dumps({"catalogVersion": CATALOG_VERSION, "sampleRate": SAMPLE_RATE, "channels": 1, "joinGapMs": JOIN_GAP_MS, "segments": segments}, indent=2) + " as const;\nexport type LiveEngineerAudioSegment = (typeof LIVE_ENGINEER_AUDIO_CATALOG.segments)[number];\n")
    return 0
def check() -> tuple[bool, dict]:
    failures: list[str] = []
    if not MANIFEST.exists(): failures.append(f"missing manifest: {MANIFEST}")
    manifest = None
    if MANIFEST.exists():
        try: manifest = json.loads(MANIFEST.read_text())
        except Exception as exc: failures.append(f"invalid manifest: {exc}")
    if manifest is not None:
        if manifest.get("catalogVersion") != CATALOG_VERSION: failures.append("catalog version mismatch")
        if manifest.get("pipelineVersion") != PIPELINE_VERSION: failures.append("pipeline version mismatch")
        if manifest.get("sampleRate") != SAMPLE_RATE or manifest.get("channels") != 1: failures.append("format metadata mismatch")
        for clip in manifest.get("clips", []):
            path = OUT / clip.get("path", "")
            if not path.is_file(): failures.append(f"missing clip: {path}"); continue
    report = {"pipelineVersion": PIPELINE_VERSION, "catalogVersion": CATALOG_VERSION, "passed": not failures, "failures": failures}
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    return not failures, report

def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--render", action="store_true"); parser.add_argument("--segment"); parser.add_argument("--batch-size", type=int, default=1); parser.add_argument("--trim-existing", action="store_true"); parser.add_argument("--validate", action="store_true"); parser.add_argument("--check", action="store_true"); parser.add_argument("--force", action="store_true"); parser.add_argument("--ref-audio", default=os.environ.get("LIVE_ENGINEER_REF_AUDIO", str(DEFAULT_REF_AUDIO))); parser.add_argument("--ref-text", default=os.environ.get("LIVE_ENGINEER_REF_TEXT", "")); args = parser.parse_args()
    if args.trim_existing: return trim_existing_catalog()
    if args.render:
        if not args.ref_audio or not args.ref_text: parser.error("--render requires --ref-audio and --ref-text (or LIVE_ENGINEER_REF_AUDIO/LIVE_ENGINEER_REF_TEXT)")
        return render(args)
    passed, report = check()
    if args.validate and passed:
        failures = validate_audio_catalog()
        report = {**report, "passed": not failures, "failures": failures}
        REPORT.write_text(json.dumps(report, indent=2) + "\n")
        passed = not failures
    print(json.dumps(report, indent=2)); return 0 if passed else 1

if __name__ == "__main__": raise SystemExit(main())
