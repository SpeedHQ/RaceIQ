import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";
import { iterateSessionCaptureRecordsFromSource, loadSessionSource } from "@raceiq/backend-core/session-capture/source-loader";
import { encodeLMUSourcePayload, LMU_SOURCE_FRAME_MAGIC, LMU_SOURCE_FRAME_SIZE, LMU_SOURCE_FRAME_V2_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SCORING_INFO_SIZE, LMU_TELEMETRY_INFO_SIZE } from "@raceiq/capture-formats/lmu/layout";
import { encodeLmuSparseFrame } from "@raceiq/capture-formats/session/lmu-sparse";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("accepts released LMU source checkpoint-only captures with version-1 provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-released-lmu-"));
  directories.push(directory);
  const frame = encodeLMUSourcePayload({ gameVersion: 1, sessionEvent: 1, captureTimestampMs: 1_000, telemetry: Buffer.alloc(LMU_TELEMETRY_INFO_SIZE), scoringInfo: Buffer.alloc(LMU_SCORING_INFO_SIZE) });
  expect(frame.length).toBe(LMU_SOURCE_FRAME_SIZE);
  const capture = Buffer.concat([encodeMetaFrame(1), encodeFrameLength(frame.length), frame]);
  const rawFile = join(directory, "lmu-capture.bin.gz");
  writeFileSync(rawFile, gzipSync(capture));
  const source = { rawFile, source: null, gameId: "lmu" as const, carId: "ferrari_499p_2023", trackId: "lemans_2023/lemanswec", captureFormatVersion: 1 };
  const records = [];
  for await (const record of iterateSessionCaptureRecordsFromSource(source)) records.push(record);
  expect(records).toEqual([{ kind: "frame", offset: 12, endOffset: 12 + 4 + frame.length, frame }]);
  const loaded = await loadSessionSource(source);
  expect(loaded.kind).toBe("capture");
  if (loaded.kind !== "capture") throw new Error("Expected capture source");
  expect(loaded.buffer).toEqual(capture);
});

test("accepts native LMU v2-to-v3 sparse checkpoint chains", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-mixed-native-"));
  directories.push(directory);
  const v2 = Buffer.alloc(LMU_SOURCE_FRAME_V2_SIZE);
  LMU_SOURCE_FRAME_MAGIC.copy(v2);
  v2.writeUInt16LE(2, 8);
  const v3 = Buffer.concat([Buffer.from(v2), Buffer.alloc(4)]);
  v3.writeUInt16LE(3, 8);
  const delta = encodeLmuSparseFrame(v3, v2, encodeFrameLength(v2.length).length + v2.length);
  const capture = Buffer.concat([encodeMetaFrame(1), encodeSparseCaptureFormatFrame(), encodeFrameLength(v2.length), v2, encodeFrameLength(delta.length), delta]);
  const rawFile = join(directory, "mixed-native.bin");
  writeFileSync(rawFile, capture);
  const records = [];
  for await (const record of iterateSessionCaptureRecordsFromSource({ rawFile, source: null, gameId: "lmu", carId: "car", trackId: "track", captureFormatVersion: 1 }, { strict: true })) {
    if (record.kind === "frame") records.push(record.frame);
  }
  expect(records).toEqual([v2, v3]);
});
