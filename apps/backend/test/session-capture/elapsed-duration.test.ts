import { beforeAll, expect, test } from "bun:test";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { initServerGameAdapters } from "../../src/games/init";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  encodeFrameLength,
  encodeMetaFrame,
  encodeSegmentBoundaryFrame,
  encodeSegmentContextFrame,
  encodeSegmentContextEndFrame,
  encodeSparseCaptureFormatFrame,
} from "@raceiq/capture-formats/session/framing";
import { getRecordedElapsedSeconds } from "@raceiq/backend-core/session-capture/elapsed-duration";
beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));

function captureFrame(time: number): Buffer {
  const frame = Buffer.from([1, 2, 3]);
  return Buffer.concat([encodeFrameLength(frame.length, time), frame]);
}


test("recovers timestamped duration across segments while excluding context and gaps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-elapsed-duration-"));
  try {
    const capture = Buffer.concat([
      encodeMetaFrame(5), encodeSparseCaptureFormatFrame(), captureFrame(1_000), captureFrame(11_000),
      encodeSegmentBoundaryFrame(), encodeSegmentContextFrame(), captureFrame(99_000),
      encodeSegmentContextEndFrame(), captureFrame(200_000), captureFrame(205_000),
    ]);
    const rawFile = join(directory, "session.bin.gz");
    writeFileSync(rawFile, gzipSync(capture));
    expect(await getRecordedElapsedSeconds({
      rawFile, source: null, gameId: "fm-2023", carId: "7", trackId: "8",
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
      rawFile, source: null, gameId: "acc", carId: "", trackId: "",
    })).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
 

test("invalidates cached duration when capture grows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-elapsed-cache-"));
  try {
    const rawFile = join(directory, "growing.bin");
    const writeCapture = (times: number[]) => writeFileSync(rawFile, Buffer.concat([
      encodeMetaFrame(times.length), encodeSparseCaptureFormatFrame(), ...times.map((time) => captureFrame(time)),
    ]));
    writeCapture([1_000, 2_000]);
    const source = { rawFile, source: null, gameId: "fm-2023" as const, carId: "7", trackId: "8" };
    expect(await getRecordedElapsedSeconds(source)).toBe(1);
    writeCapture([1_000, 2_000, 6_000]);
    expect(await getRecordedElapsedSeconds(source)).toBe(5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
