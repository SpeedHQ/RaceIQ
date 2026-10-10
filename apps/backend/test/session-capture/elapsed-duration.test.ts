import { beforeAll, expect, test } from "bun:test";
import { LMU_TELEMETRY, LMU_TELEMETRY_INFO_SIZE, LMU_SCORING_INFO_SIZE } from "@raceiq/capture-formats/lmu/layout";
import { encodeLMUSourcePayload } from "@raceiq/capture-formats/lmu/source-frame";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { initServerGameAdapters } from "../../src/games/init";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, encodeSegmentContextFrame, encodeSegmentContextEndFrame } from "@raceiq/capture-formats/session/framing";
import { getRecordedElapsedSeconds } from "@raceiq/backend-core/session-capture/elapsed-duration";
beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));

function captureFrame(time: number): Buffer {
  const frame = Buffer.from([1, 2, 3]);
  return Buffer.concat([encodeFrameLength(frame.length, time), frame]);
}

function lmuSourceFrame(captureTimestampMs: number, elapsedTime: number): Buffer {
  const telemetry = Buffer.alloc(LMU_TELEMETRY_INFO_SIZE);
  telemetry.writeDoubleLE(elapsedTime, LMU_TELEMETRY.elapsedTime);
  return encodeLMUSourcePayload({
    gameVersion: 1,
    sessionEvent: 1,
    captureTimestampMs,
    telemetry,
    scoringInfo: Buffer.alloc(LMU_SCORING_INFO_SIZE),
  });
}

test("recovers timestamped duration across segments while excluding context and gaps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-elapsed-duration-"));
  try {
    const capture = Buffer.concat([
      encodeMetaFrame(5), captureFrame(1_000), captureFrame(11_000),
      encodeSegmentBoundaryFrame(), encodeSegmentContextFrame(), captureFrame(99_000),
      encodeSegmentContextEndFrame(), captureFrame(200_000), captureFrame(205_000),
    ]);
    const rawFile = join(directory, "session.bin.gz");
    writeFileSync(rawFile, gzipSync(capture));
    expect(await getRecordedElapsedSeconds({
      rawFile, source: null, gameId: "fm-2023", carOrdinal: 0, trackOrdinal: 0,
    })).toBe(15);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaves legacy unclocked captures unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-elapsed-duration-"));
  try {
    const rawFile = join(directory, "legacy.bin");
    const frame = Buffer.from([1, 2, 3]);
    writeFileSync(rawFile, Buffer.concat([encodeMetaFrame(1), encodeFrameLength(frame.length), frame]));
    expect(await getRecordedElapsedSeconds({
      rawFile, source: null, gameId: "acc", carOrdinal: 0, trackOrdinal: 0,
    })).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
 
test("prefers embedded LMU acquisition UTC over simulator elapsed clock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-elapsed-lmu-"));
  try {
    const rawFile = join(directory, "lmu.bin");
    const first = lmuSourceFrame(1_790_111_999_401, 0);
    const last = lmuSourceFrame(1_790_112_004_402, 2);
    writeFileSync(rawFile, Buffer.concat([
      encodeMetaFrame(2), encodeFrameLength(first.length), first, encodeFrameLength(last.length), last,
    ]));
    expect(await getRecordedElapsedSeconds({
      rawFile, source: null, gameId: "lmu", carOrdinal: 0, trackOrdinal: 0,
    })).toBe(5.001);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalidates cached duration when capture grows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-elapsed-cache-"));
  try {
    const rawFile = join(directory, "growing.bin");
    const writeCapture = (times: number[]) => writeFileSync(rawFile, Buffer.concat([
      encodeMetaFrame(times.length), ...times.map((time) => captureFrame(time)),
    ]));
    writeCapture([1_000, 2_000]);
    const source = { rawFile, source: null, gameId: "fm-2023" as const, carOrdinal: 0, trackOrdinal: 0 };
    expect(await getRecordedElapsedSeconds(source)).toBe(1);
    writeCapture([1_000, 2_000, 6_000]);
    expect(await getRecordedElapsedSeconds(source)).toBe(5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
