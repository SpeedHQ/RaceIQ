import { describe, expect, test } from "bun:test";
import { initServerGameAdapters } from "../../server/games/init";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { encodeFrameLength, encodeMetaFrame } from "../../server/session-capture/framing";
import { ImportCaptureAdapter, importErrorPayload, IncompleteImportError, InvalidImportDataError } from "../../server/session-capture/import-pipeline";
import { CapturingDbAdapter } from "../../server/telemetry/pipeline-ports";
import type { PersistLapInput } from "../../server/db/lap-mutation-queries";
import { initGameAdapters } from "../../shared/games/init";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";
import { qualityPackets, summarize, TEST_VERSION_IDENTITY } from "../support/lap-analysis/quality-model";

initGameAdapters();
initServerGameAdapters();

function lapInput(
  sessionId: number,
  lapNumber: number,
  quality: NonNullable<PersistLapInput["quality"]>,
): PersistLapInput {
  return {
    sessionId,
    lapNumber,
    lapTime: 10,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 3,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    classification: DEFAULT_LAP_CLASSIFICATION,
    quality,
    eligibility: evaluateAllEligibility(quality),
    versionIdentity: TEST_VERSION_IDENTITY,
  };
}

function recordingQuality(sourceGeneration: string) {
  const accumulator = new RecordingQualityAccumulator("raceiq-raw", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
  for (const packet of qualityPackets(3)) accumulator.observe(packet);
  return accumulator.finalize("session-rotated", {
    state: "verified",
    sourceGeneration,
  });
}

describe("telemetry import quality errors", () => {
  test("serializes corrupt and incomplete imports with machine-readable quality reasons", () => {
    expect(importErrorPayload(new InvalidImportDataError())).toEqual({
      error: "Import contains unusable telemetry data",
      code: "INVALID_IMPORT_DATA",
      quality: { lifecycleState: "corrupt", reasons: ["recording_corrupt"] },
    });
    expect(importErrorPayload(new IncompleteImportError())).toEqual({
      error: "No complete, importable laps were found",
      code: "INCOMPLETE_IMPORT",
      quality: { lifecycleState: "incomplete", reasons: ["recording_incomplete"] },
    });
  });

  test("rejects truncated framing as corrupt instead of reporting no laps", async () => {
    const truncated = Buffer.alloc(6);
    truncated.writeUInt32LE(10, 0);
    truncated.writeUInt8(0xaa, 4);
    truncated.writeUInt8(0xbb, 5);

    await expect(importSessionBin(truncated, "acc", { requireLaps: true })).rejects.toMatchObject({
      code: "INVALID_IMPORT_DATA",
      lifecycleState: "corrupt",
      reasons: ["recording_corrupt"],
    });
  });

  test("rejects truncated recorder metadata instead of treating it as an empty capture", async () => {
    const metadata = encodeMetaFrame(0);
    for (const length of [4, 8]) {
      await expect(importSessionBin(metadata.subarray(0, length), "acc", { requireLaps: true })).rejects.toMatchObject({
        code: "INVALID_IMPORT_DATA",
        lifecycleState: "corrupt",
        reasons: ["recording_corrupt"],
      });
    }
  });

  test("rejects cleanly framed captures whose declared frame count does not match", async () => {
    for (const [declaredCount, actualCount] of [[2, 1], [1, 2]]) {
      const records = Array.from({ length: actualCount }, (_, index) => {
        const payload = Buffer.from([index]);
        return Buffer.concat([encodeFrameLength(payload.length), payload]);
      });
      const capture = Buffer.concat([encodeMetaFrame(declaredCount), ...records]);

      await expect(importSessionBin(capture, "acc", { requireLaps: true })).rejects.toMatchObject({
        code: "INVALID_IMPORT_DATA",
        lifecycleState: "corrupt",
        reasons: ["recording_corrupt"],
        cause: {
          message: `Recorder metadata declares ${declaredCount} frames, but capture contains ${actualCount}`,
        },
      });
    }
  });

  test("reports a readable complete stream with no detected laps as incomplete", async () => {
    await expect(importSessionBin(encodeMetaFrame(0), "acc", { requireLaps: true })).rejects.toMatchObject({
      code: "INCOMPLETE_IMPORT",
      lifecycleState: "incomplete",
      reasons: ["recording_incomplete"],
    });
  });

  test("waits for delayed lap writes before each imported session quality update", async () => {
    const persistence = new CapturingDbAdapter();
    const insertLap = persistence.insertLap.bind(persistence);
    const updateSessionQuality = persistence.updateSessionQuality.bind(persistence);
    const lapWriteGates = new Map<number, Promise<void>>();
    const updatedSessions: number[] = [];
    persistence.insertLap = async (input) => {
      await lapWriteGates.get(input.sessionId);
      return insertLap(input);
    };
    persistence.updateSessionQuality = async (sessionId, quality) => {
      updatedSessions.push(sessionId);
      return updateSessionQuality(sessionId, quality);
    };
    const capture = new ImportCaptureAdapter({ db: persistence });
    const sessionIds = [
      await capture.insertSession(100, 5, "fm-2023", undefined, TEST_VERSION_IDENTITY, "raceiq-raw"),
      await capture.insertSession(101, 5, "fm-2023", undefined, TEST_VERSION_IDENTITY, "raceiq-raw"),
    ];
    const lapQuality = summarize(qualityPackets(3), {
      sourceKind: "raceiq-raw",
      versionIdentity: TEST_VERSION_IDENTITY,
    });

    for (const [index, sessionId] of sessionIds.entries()) {
      let releaseLapWrite!: () => void;
      lapWriteGates.set(
        sessionId,
        new Promise<void>((resolve) => {
          releaseLapWrite = resolve;
        }),
      );
      const pendingLap = capture.insertLap(lapInput(sessionId, index + 1, lapQuality));
      const pendingQuality = capture.updateSessionQuality(
        sessionId,
        recordingQuality(`sha256:source-${sessionId}`),
      );

      expect(updatedSessions).toEqual(sessionIds.slice(0, index));
      releaseLapWrite();
      await pendingLap;
      await pendingQuality;
      expect(updatedSessions).toEqual(sessionIds.slice(0, index + 1));
    }
  });
});
