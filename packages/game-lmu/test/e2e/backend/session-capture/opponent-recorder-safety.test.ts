import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { encodeFrameLength, encodeSegmentContextFrame, encodeSegmentContextEndFrame, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { partitionLMUSourceFrame } from "@raceiq/capture-formats/lmu/partition";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { DirectCaptureRecording } from "@raceiq/backend-core/session-capture/direct-recorder";
import { readLmuOpponentRetention } from "@raceiq/backend-core/session-capture/lmu-companion";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";

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

