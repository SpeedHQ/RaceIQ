import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { encodeFrameLength, encodeMetaFrame, encodeSparseCaptureFormatFrame } from "@raceiq/capture-formats/session/framing";
import { decodeLMUSourceFrame, encodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SCORING_INFO, LMU_SCORING_INFO_OFFSET, LMU_SCORING_VEHICLE, LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLES_OFFSET } from "@raceiq/capture-formats/lmu/layout";
import { makeLmuOpponentCapture } from "@raceiq/game-lmu/test-support/opponents";
import { iterateLmuOpponentCaptureFrames } from "@raceiq/backend-core/lap-analysis/lmu-opponent-laps";

describe("LMU native V2 opponent identity", () => {
  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const file of tmpFiles) rmSync(file, { force: true, recursive: true });
    tmpFiles.length = 0;
  });

  test("contextless sparse V2 frames derive player ID and emit two opponents", async () => {
    const sourceCapture = gunzipSync(makeLmuOpponentCapture());
    const sourceFrame = [...iterateSessionCaptureRecords(sourceCapture, 0, { strict: true })]
      .find((record) => record.kind === "frame");
    expect(sourceFrame?.kind).toBe("frame");
    if (sourceFrame?.kind !== "frame") throw new Error("Fixture has no native frame");
    const decoded = decodeLMUSourceFrame(sourceFrame.frame);
    expect(decoded?.schemaVersion).toBe(3);
    if (!decoded?.rawSharedMemory) throw new Error("Fixture has no shared memory");

    const memory = Buffer.from(decoded.rawSharedMemory);
    const playerOffset = LMU_SCORING_VEHICLES_OFFSET;
    const firstOpponentOffset = playerOffset + LMU_SCORING_VEHICLE_SIZE;
    const secondOpponentOffset = firstOpponentOffset + LMU_SCORING_VEHICLE_SIZE;
    memory.copy(memory, secondOpponentOffset, firstOpponentOffset, secondOpponentOffset);
    memory.writeInt32LE(3, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    memory.writeInt32LE(99, secondOpponentOffset + LMU_SCORING_VEHICLE.id);
    memory.writeUInt8(0, secondOpponentOffset + LMU_SCORING_VEHICLE.isPlayer);
    const frame = encodeLMUSourceFrame(memory, decoded.captureTimestampMs);
    expect(frame?.readUInt16LE(8)).toBe(2);
    if (!frame) throw new Error("Could not encode native V2 frame");

    const encoded = [encodeMetaFrame(), encodeSparseCaptureFormatFrame()];
    const prefix = encodeFrameLength(frame.length, decoded.captureTimestampMs);
    encoded.push(prefix, frame);
    const second = encodeFrameLength(frame.length, decoded.captureTimestampMs + 50);
    encoded.push(second, frame);

    const root = mkdtempSync(join(tmpdir(), "raceiq-lmu-native-v2-"));
    const rawFile = join(root, "capture.bin");
    tmpFiles.push(root);
    writeFileSync(rawFile, Buffer.concat(encoded));
    const source = { rawFile, source: null, gameId: "lmu" as const, carId: "native-v2", trackId: "native-v2" };
    const emitted = [];
    for await (const snapshot of iterateLmuOpponentCaptureFrames(source, { retainSourceFrames: false })) emitted.push(snapshot);

    expect(emitted).toHaveLength(2);
    for (const snapshot of emitted) {
      expect(snapshot.lmuContext).toBeUndefined();
      expect(snapshot.competitors.map((competitor) => competitor.vehicleId)).toEqual([42, 7, 99]);
      expect(snapshot.competitors.find((competitor) => competitor.vehicleId === 42)?.isPlayer).toBe(true);
    }
  });
});
