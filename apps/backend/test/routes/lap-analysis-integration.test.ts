import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import { db } from "@raceiq/backend-core/db/index";
import { laps } from "@raceiq/backend-core/db/schema";
import { insertLap } from "@raceiq/backend-core/db/lap-mutation-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "@raceiq/backend-core/db/session-queries";
import { cacheDelete } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../src/games/init";
import { lapRoutes } from "../../src/routes/laps/index";
import { iterateSessionCaptureFrames, setCaptureFileFactoryForTest } from "@raceiq/backend-core/session-capture/source-loader";
import { SessionRecorder } from "@raceiq/capture-formats/session/recorder";
import { SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { getRecordingFixture } from "@raceiq/backend-core/test-support/recordings/fixtures";


initServerGameAdapters();
describe("F1 Analyse semantic telemetry integration", () => {
  test("replays sparse capture identically to raw recording through streaming Analyse path", async () => {
    const fixture = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
    if (!fixture) throw new Error("Required F1 recording fixture is missing");
    const tempDir = mkdtempSync(join(tmpdir(), "raceiq-analyse-sparse-"));
    const previousDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
    const sparse = new SparseSessionRecorderAdapter();
    const raw = new SessionRecorder();
    const lapIds: number[] = [];
    const sessionIds: number[] = [];
    let sparseOffset: number | undefined;
    let rawOffset: number | undefined;
    let sparseFrameIndex: number | undefined;
    try {
      sparse.start("f1-2025");
      sparse.writeMetaFrame();
      raw.start(join(tempDir, "raw.bin"));
      raw.writeMetaFrame();
      for await (const record of iterateSessionCaptureFrames({
        rawFile: fixture, source: null, gameId: "f1-2025", carOrdinal: 41, trackOrdinal: 19,
      })) {
        sparse.writeRecord(record.frame);
        raw.writeRecord(record.frame);
      }
      const sparseFile = sparse.path;
      await sparse.stop();
      await raw.stop();
      if (!sparseFile) throw new Error("Sparse recorder did not produce a capture");
      const rawFile = raw.path;
      if (!rawFile) throw new Error("Raw recorder did not produce a capture");

      const sparseBytes = readFileSync(sparseFile);
      const rawBytes = readFileSync(rawFile);
      let sparseCursor = 12;
      let rawCursor = 12;
      let frameIndex = 0;
      while (sparseCursor + 4 <= sparseBytes.length && rawCursor + 4 <= rawBytes.length) {
        const sparseLength = sparseBytes.readUInt32LE(sparseCursor);
        const rawLength = rawBytes.readUInt32LE(rawCursor);
        if (sparseLength === 0 || sparseCursor + 4 + sparseLength > sparseBytes.length ||
            rawLength === 0 || rawCursor + 4 + rawLength > rawBytes.length) break;
        if (sparseBytes.toString("ascii", sparseCursor + 4, sparseCursor + 8) === "RQSD") {
          sparseOffset = sparseCursor;
          rawOffset = rawCursor;
          sparseFrameIndex = frameIndex;
          break;
        }
        sparseCursor += 4 + sparseLength;
        rawCursor += 4 + rawLength;
        frameIndex++;
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
          const sessionId = await insertSession(41, 19, "f1-2025");
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
        expect(streamCalls).toBe(2);
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
      if (previousDataDir == null) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 120000);


  test("replays a real capture through the Analyse endpoint", async () => {
    const recording = getRecordingFixture("f1-2025-2026-04-09T21-34-10-190Z.bin.gz");
    if (!recording) throw new Error("Required F1 recording fixture is missing");

    let firstFrameOffset: number | undefined;
    for await (const record of iterateSessionCaptureFrames({
      rawFile: recording,
      source: null,
      gameId: "f1-2025",
      carOrdinal: 41,
      trackOrdinal: 19,
    })) {
      firstFrameOffset = record.offset;
      break;
    }
    if (firstFrameOffset == null) throw new Error("Recording contains no frames");

    const sessionId = await insertSession(41, 19, "f1-2025");
    const lapId = await insertLap(sessionId, 1, 1, true, firstFrameOffset, 1_000);
    await updateSessionRawFile(sessionId, recording, "test-detector");

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
      expect(streamCalls).toBe(1);
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
    }
  }, 120000);
});
