import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { db } from "@raceiq/backend-core/db/index";
import { laps } from "@raceiq/backend-core/db/schema";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import { cacheDelete } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../src/games/init";
import { lapRoutes } from "../../src/routes/laps/index";
import { iterateSessionCaptureFrames, setCaptureFileFactoryForTest } from "@raceiq/backend-core/session-capture/source-loader";
import {
  encodeSparseCaptureFormatFrame,
  iterateSessionCaptureRecords,
  iterateSessionFrames,
} from "@raceiq/capture-formats/session/framing";
import { isGenericSparseFrame } from "@raceiq/capture-formats/session/generic-sparse";
import { SessionRecorder } from "@raceiq/capture-formats/session/recorder";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";

const sparseFixtureCleanups: Array<() => void> = [];

async function makeSparseFixture(path: string): Promise<string> {
  const converted = await convertSeedFramesToSparse(
    "f1-2025",
    iterateSessionFrames(gunzipSync(readFileSync(path))),
  );
  sparseFixtureCleanups.push(converted.cleanup);
  return converted.path;
}

function insertSparseMarkerAfterFirstFrame(bytes: Buffer): Buffer {
  const firstRecordEnd = 12 + 4 + bytes.readUInt32LE(12);
  return Buffer.concat([
    bytes.subarray(0, firstRecordEnd),
    encodeSparseCaptureFormatFrame(),
    bytes.subarray(firstRecordEnd),
  ]);
}

initServerGameAdapters();
afterEach(() => {
  for (const cleanup of sparseFixtureCleanups.splice(0)) cleanup();
});
describe("F1 Analyse semantic telemetry integration", () => {
  test("replays sparse deltas identically to sparse-marked raw frames through streaming Analyse", async () => {
    const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
    if (!fixture) throw new Error("Required F1 recording fixture is missing");
    const tempDir = mkdtempSync(join(tmpdir(), "raceiq-analyse-sparse-"));
    const raw = new SessionRecorder();
    const lapIds: number[] = [];
    const sessionIds: number[] = [];
    let sparseOffset: number | undefined;
    let rawOffset: number | undefined;
    let sparseFrameIndex: number | undefined;
    try {
      const sparseFixture = await makeSparseFixture(fixture);
      raw.start(join(tempDir, "raw.bin"));
      raw.writeMetaFrame();
      for await (const record of iterateSessionCaptureFrames({
        rawFile: sparseFixture, source: null, gameId: "f1-2025", carId: "41", trackId: "19",
      })) {
        raw.writeRecord(record.frame);
      }
      const sparseFile = sparseFixture;
      const rawFile = raw.path;
      await raw.stop();
      if (!rawFile) throw new Error("Raw recorder did not produce a capture");
      writeFileSync(rawFile, insertSparseMarkerAfterFirstFrame(readFileSync(rawFile)));

      const sparseBytes = readFileSync(sparseFile);
      const rawBytes = readFileSync(rawFile);
      const sparseRecords = [...iterateSessionCaptureRecords(sparseBytes)];
      let frameIndex = 0;
      for (const record of sparseRecords) {
        if (record.kind !== "frame") continue;
        const length = sparseBytes.readUInt32LE(record.offset);
        const encodedFrame = sparseBytes.subarray(record.offset + 4, record.offset + 4 + length);
        if (isGenericSparseFrame(encodedFrame)) {
          sparseOffset = record.offset;
          sparseFrameIndex = frameIndex;
          break;
        }
        frameIndex++;
      }
      if (sparseFrameIndex != null) {
        let rawFrameIndex = 0;
        for (const record of iterateSessionCaptureRecords(rawBytes)) {
          if (record.kind !== "frame") continue;
          if (rawFrameIndex === sparseFrameIndex) {
            rawOffset = record.offset;
            break;
          }
          rawFrameIndex++;
        }
      }
      if (sparseOffset == null || rawOffset == null || sparseFrameIndex == null) {
        throw new Error("F1 fixture did not produce a generic sparse delta");
      }
      const recordings: Array<{ path: string; offset: number }> = [
        { path: sparseFile, offset: sparseOffset },
        { path: rawFile, offset: rawOffset },
      ];
      const results: Array<{ receivedAt: { milliseconds: number }; sequence: number; observedAt: unknown; simulator: string; values: unknown[] }[]> = [];
      let fileCalls = 0;
      let streamCalls = 0;
      const originalFile = Bun.file;
      setCaptureFileFactoryForTest((path) => {
        fileCalls++;
        const file = originalFile(path);
        return {
          size: file.size,
          lastModified: file.lastModified,
          slice: (start?: number, end?: number) => file.slice(start, end),
          stream: () => { streamCalls++; return file.stream(); },
          arrayBuffer: () => { throw new Error("Analyse replay must not materialize the full capture"); },
        };
      });
      try {
        for (const recording of recordings) {
          const sessionId = await insertSession("41", "19", "f1-2025");
          sessionIds.push(sessionId);
          const lapId = await insertLap(sessionId, 1, 1, true, recording.offset, 1_000);
          lapIds.push(lapId);
          if (results.length === 1) {
            await db.update(laps).set({ createdAt: "2000-01-01 00:00:00" }).where(eq(laps.id, lapId)).run();
          }
          await updateSessionRawFile(sessionId, recording.path, "test-detector");
          const response = await lapRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
            headers: { "X-Game-Id": "f1-2025" },
          });
          expect(response.status).toBe(200);
          const body = await response.json() as {
            lapId: number;
            requestedSemanticIds: string[];
            envelopes: { receivedAt: { milliseconds: number }; sequence: number; observedAt: unknown; simulator: string; values: { semanticId: string; value?: unknown }[] }[];
            parseError: string | null;
          };
          expect(body.lapId).toBe(lapId);
          expect(body.parseError).toBeNull();
          expect(body.requestedSemanticIds).toContain("tire.temperature.core");
          expect(body.envelopes.length).toBeGreaterThan(0);
          expect(body.envelopes.map((envelope) => envelope.sequence)).toEqual(body.envelopes.map((_, index) => index));
          expect(body.envelopes.every((envelope) => envelope.receivedAt.milliseconds === body.envelopes[0]!.receivedAt.milliseconds)).toBe(true);
          results.push(body.envelopes);
        }
        expect(fileCalls).toBe(2);
        expect(streamCalls).toBe(4);
      } finally {
        setCaptureFileFactoryForTest(null);
      }
      expect(results[1]![0]!.receivedAt.milliseconds).toBe(Date.parse("2000-01-01T00:00:00Z"));
      expect(results[0]![0]!.receivedAt).not.toEqual(results[1]![0]!.receivedAt);
      expect(results[0]!.map(({ receivedAt: _receivedAt, ...capture }) => capture))
        .toEqual(results[1]!.map(({ receivedAt: _receivedAt, ...capture }) => capture));
    } finally {
      setCaptureFileFactoryForTest(null);
      for (const lapId of lapIds) cacheDelete(lapId);
      for (const sessionId of sessionIds) await deleteSession(sessionId);
      rmSync(tempDir, { recursive: true, force: true });
      for (const cleanup of sparseFixtureCleanups.splice(0)) cleanup();
    }
  }, 120000);


  test("replays a real capture through the Analyse endpoint", async () => {
    const recording = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
    if (!recording) throw new Error("Required F1 recording fixture is missing");
    const sparseRecording = await makeSparseFixture(recording);
    let firstFrameOffset: number | undefined;
    for await (const record of iterateSessionCaptureFrames({
      rawFile: sparseRecording,
      source: null,
      gameId: "f1-2025",
      carId: "41",
      trackId: "19",
    })) {
      firstFrameOffset = record.offset;
      break;
    }
    if (firstFrameOffset == null) throw new Error("Recording contains no frames");

    const sessionId = await insertSession("41", "19", "f1-2025");
    const lapId = await insertLap(sessionId, 1, 1, true, firstFrameOffset, 1_000);
    await updateSessionRawFile(sessionId, sparseRecording, "test-detector");

    let fileCalls = 0;
    let streamCalls = 0;
    const originalFile = Bun.file;
    setCaptureFileFactoryForTest((path) => {
      fileCalls++;
      const file = originalFile(path);
      return {
        size: file.size,
        lastModified: file.lastModified,
        slice: (start?: number, end?: number) => file.slice(start, end),
        stream: () => {
          streamCalls++;
          return file.stream();
        },
        arrayBuffer: () => {
          throw new Error("Analyse replay must not materialize the full capture");
        },
      };
    });
    try {
      const response = await lapRoutes.request(`/api/laps/${lapId}/semantic-telemetry`, {
        headers: { "X-Game-Id": "f1-2025" },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        lapId: number;
        requestedSemanticIds: string[];
        envelopes: { sequence: number; values: { semanticId: string }[] }[];
        parseError: string | null;
      };
      expect(body.lapId).toBe(lapId);
      expect(body.parseError).toBeNull();
      expect(fileCalls).toBe(1);
      expect(streamCalls).toBe(2);
      expect(body.requestedSemanticIds).toContain("tire.temperature.core");
      expect(body.envelopes.length).toBeGreaterThan(0);
      expect(body.envelopes.map((envelope) => envelope.sequence)).toEqual(
        body.envelopes.map((_, index) => index),
      );
      expect(body.envelopes.every((envelope) => envelope.values.length > 0)).toBe(true);
    } finally {
      setCaptureFileFactoryForTest(null);
      cacheDelete(lapId);
      await deleteSession(sessionId);
      for (const cleanup of sparseFixtureCleanups.splice(0)) cleanup();
    }
  }, 120000);
});
