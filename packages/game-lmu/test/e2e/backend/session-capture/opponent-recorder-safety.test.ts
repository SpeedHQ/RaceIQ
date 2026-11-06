import { afterEach, expect, test } from "bun:test";
import { readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { encodeFrameLength, encodeSegmentContextFrame, encodeSegmentContextEndFrame, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { partitionLMUSourceFrame } from "@raceiq/capture-formats/lmu/partition";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { DirectCaptureRecording } from "@raceiq/backend-core/session-capture/direct-recorder";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { readLmuOpponentCaptureFrames } from "@raceiq/backend-core/lap-analysis/lmu-opponent-laps";

const directories: string[] = [];
const frames: Array<{ frame: Buffer; timestamp: number | undefined }> = [];
for (const record of iterateSessionCaptureRecords(gunzipSync(makeLmuOpponentCapture()), 0, { strict: true })) {
  if (record.kind === "frame") frames.push({ frame: Buffer.from(record.frame), timestamp: record.frameTimeMs });
  if (frames.length === 3) break;
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function createCapture(maxQueuedBytes?: number) {
  const directory = join(resolveRecordingDirectory(), "lmu", `opponent-safety-${crypto.randomUUID()}`);
  directories.push(directory);
  return new DirectCaptureRecording("lmu", directory, join(directory, "capture-manifest.json"), {
    ...(maxQueuedBytes === undefined ? {} : { writerOptions: { maxQueuedBytes } }),
  });
}
async function recordedFrames(capture: DirectCaptureRecording) {
  const result: Buffer[] = [];
  for await (const record of iterateSessionCaptureRecordsFromSource({
    rawFile: capture.path, source: null, gameId: "lmu", carId: "fixture-player", trackId: "RaceIQ Opponent Fixture",
  }, { strict: true })) if (record.kind === "frame") result.push(record.frame);
  return result;
}

test("companion queue failure preserves every player frame and publishes incomplete opponent retention", async () => {
  const partition = partitionLMUSourceFrame(frames[0]!.frame)!;
  const capture = createCapture(Math.floor((partition.primary.length + partition.companion!.length) / 2));
  try {
    await capture.ready;
    for (const frame of frames) {
      capture.writeRecord(frame.frame, frame.timestamp);
      await capture.drainWrites();
    }
    expect(capture.hasFailed).toBe(false);
    await capture.stop();
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject({ opponentRetention: "retained", opponentAvailability: "incomplete" });
    const restored = await recordedFrames(capture);
    expect(restored.map((frame) => decodeLMUSourceFrame(frame)!.telemetry)).toEqual(frames.map(({ frame }) => decodeLMUSourceFrame(frame)!.telemetry));
    expect(restored.every((frame) => !decodeLMUSourceFrame(frame)!.lmuContext?.competitors?.some((entry) => !entry.isPlayer))).toBe(true);
  } finally { await capture.stop().catch(() => {}); }
});

test("context-ending metadata resets primary checkpoint before the next owned frame", async () => {
  const capture = createCapture();
  try {
    await capture.ready;
    const first = frames[0]!;
    capture.writeRawCaptureBytes(Buffer.concat([
      encodeSegmentContextFrame(), encodeFrameLength(first.frame.length, first.timestamp), first.frame, encodeSegmentContextEndFrame(),
    ]));
    capture.writeRecord(frames[1]!.frame, frames[1]!.timestamp);
    await capture.stop();
    expect(await recordedFrames(capture)).toEqual(frames.slice(0, 2).map(({ frame }) => frame));
  } finally { await capture.stop().catch(() => {}); }
});

test("warm companion validation detects changed, replaced, missing and repaired source files", async () => {
  const capture = createCapture();
  try {
    await capture.ready;
    for (const frame of frames) capture.writeRecord(frame.frame, frame.timestamp);
    await capture.stop();
    const manifest = JSON.parse(await readFile(capture.path, "utf8"));
    const companionPath = join(dirname(capture.path), manifest.opponentCompanion.file);
    const original = await readFile(companionPath);
    const originalInfo = await stat(companionPath);
    const retained = { opponentRetention: "retained", opponentAvailability: "complete" };
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject(retained);
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject(retained);

    const damaged = Buffer.from(original);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    await writeFile(companionPath, damaged);
    await utimes(companionPath, originalInfo.atime, new Date(originalInfo.mtimeMs + 2000));
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject({ opponentAvailability: "corrupt" });
    await writeFile(companionPath, original);
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject(retained);

    const replacement = `${companionPath}.replacement`;
    await writeFile(replacement, damaged);
    await rename(replacement, companionPath);
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject({ opponentAvailability: "corrupt" });
    await writeFile(companionPath, original.subarray(1));
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject({ opponentAvailability: "corrupt" });
    await rm(companionPath);
    expect(await readLmuOpponentRetention(capture.path)).toMatchObject({ opponentAvailability: "missing" });
    await writeFile(companionPath, original);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => readLmuOpponentRetention(capture.path)));
    for (const result of concurrent) expect(result).toMatchObject(retained);

    const restored = await readLmuOpponentCaptureFrames({
      rawFile: capture.path, source: null, gameId: "lmu", carId: "fixture-player", trackId: "RaceIQ Opponent Fixture",
    }, manifest.sourceRevision);
    expect(restored.map((frame) => frame.lmuContext)).toEqual(frames.map(({ frame }) => decodeLMUSourceFrame(frame)!.lmuContext));
    expect(restored.map((frame) => frame.sourceFrame)).toEqual(frames.map(({ frame }) => frame));
    const observations = await readLmuOpponentCaptureFrames({
      rawFile: capture.path, source: null, gameId: "lmu", carId: "fixture-player", trackId: "RaceIQ Opponent Fixture",
    }, manifest.sourceRevision, { retainSourceFrames: false });
    expect(observations).toEqual(restored.map(({ sourceFrame: _sourceFrame, parserBootstrap: _parserBootstrap, ...frame }) => frame));
    expect(await readFile(companionPath)).toEqual(original);
  } finally { await capture.stop().catch(() => {}); }
});

