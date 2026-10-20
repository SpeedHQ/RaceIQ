import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { SessionRecorder } from "@raceiq/capture-formats/session/recorder";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeSparseCaptureFormatFrame, iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { encodeGenericSparseFrame, genericFrameIdentity } from "@raceiq/capture-formats/session/generic-sparse";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { f1Parser } from "../src/game-parser";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";

const fixtureName = process.argv[2] ?? "f1-2025-2026-04-22T11-42-43-029Z.bin.gz";
const fixture = getRecordingFixture(fixtureName);
if (!fixture) throw new Error(`Required recording fixture missing: ${fixtureName}`);
const sourceBytes = gunzipSync(readFileSync(fixture));
const frames = [...iterateSessionFrames(sourceBytes)];
const root = mkdtempSync(join(tmpdir(), "raceiq-f1-capture-measure-"));
const baselinePath = join(root, "baseline.bin");
const compactPath = join(root, "compact.bin");
const baseline = new SessionRecorder();
const compact = new SparseSessionRecorder("f1-2025");
let previous: Buffer | null = null;
let checkpointOffset = 12;
let framesSinceCheckpoint = 0;
let baselineOffset = 12;
let sparseMarkerWritten = false;
try {
  baseline.start(baselinePath);
  baseline.writeMetaFrame();
  compact.start(compactPath);
  compact.writeMetaFrame();
  for (const frame of frames) {
    const identity = genericFrameIdentity(frame);
    const storage = frame;
    const adjacent = previous && previous.length === storage.length && identity !== null &&
      genericFrameIdentity(previous) === identity;
    let encoded = storage;
    if (adjacent && framesSinceCheckpoint < 128) {
      const delta = encodeGenericSparseFrame(storage, previous!, baselineOffset - checkpointOffset);
      if (delta.length < storage.length) encoded = delta;
    }
    if (encoded === storage) {
      checkpointOffset = baselineOffset;
      framesSinceCheckpoint = 0;
    }
    previous = storage;
    framesSinceCheckpoint++;
    baseline.writeRecord(encoded);
    baselineOffset += encoded.length + 4;
    if (!sparseMarkerWritten) {
      const marker = encodeSparseCaptureFormatFrame();
      baseline.writeRawCaptureBytes(marker);
      baselineOffset += marker.length;
      sparseMarkerWritten = true;
    }
    compact.writeRecord(frame);
  }
  await Promise.all([baseline.stop(), compact.stop()]);
  const baselineRaw = readFileSync(baselinePath);
  const compactRaw = readFileSync(compactPath);
  const baselineGzip = gzipSync(baselineRaw);
  const compactGzip = gzipSync(compactRaw);
  function replayDigest(bytes: Buffer) {
    const state = f1Parser.createParserState();
    const digest = createHash("sha256");
    let packets = 0;
    let lapTransitions = 0;
    let previousLap: number | undefined;
    for (const frame of iterateSessionFrames(bytes)) {
      const packet = f1Parser.tryParse(frame, state);
      if (!packet) continue;
      digest.update(JSON.stringify(packet));
      packets++;
      if (previousLap !== undefined && packet.LapNumber > previousLap) lapTransitions++;
      previousLap = packet.LapNumber;
    }
    return { packets, lapTransitions, sha256: digest.digest("hex") };
  }
  const nativeReplay = replayDigest(sourceBytes);
  const baselineReplay = replayDigest(baselineRaw);
  const compactReplay = replayDigest(compactRaw);
  assert.deepEqual(baselineReplay, nativeReplay, "Sparse baseline changed replay telemetry");
  assert.deepEqual(compactReplay, nativeReplay, "Compact recording changed replay telemetry");
  console.log(JSON.stringify({
    fixture: fixtureName,
    packets: frames.length,
    replay: compactReplay,
    sparseBaseline: { rawBytes: baselineRaw.length, gzipBytes: baselineGzip.length },
    compact: { rawBytes: compactRaw.length, gzipBytes: compactGzip.length },
    saved: {
      rawBytes: baselineRaw.length - compactRaw.length,
      rawPercent: Number(((1 - compactRaw.length / baselineRaw.length) * 100).toFixed(2)),
      gzipBytes: baselineGzip.length - compactGzip.length,
      gzipPercent: Number(((1 - compactGzip.length / baselineGzip.length) * 100).toFixed(2)),
    },
  }, null, 2));
} finally {
  if (baseline.recording) await baseline.stop();
  if (compact.recording) await compact.stop();
  rmSync(root, { recursive: true, force: true });
}
