import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { initServerGameAdapters } from "@raceiq/backend/test-support/games";
import { hasLMUDumpMagic } from "@raceiq/capture-formats/lmu/dump";
import { fixtureFrames } from "@raceiq/backend/test-support/fixture-frames";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import { queryLapTelemetryBySemanticId } from "@raceiq/backend-core/telemetry/replay";
import { iterateSessionCaptureRecordsFromSource, loadCaptureManifest } from "@raceiq/backend-core/session-capture/source-loader";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { encodeFrameLength, encodeMetaFrame } from "@raceiq/capture-formats/session/framing";
import { readRecordedTelemetry } from "@raceiq/backend/test-support/replay-packets";
import { decodeLMUSourceFrame, encodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SESSION_EVENT_OFFSET } from "@raceiq/capture-formats/lmu/layout";

import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
const fixturePath = "packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-2026-10-22.bin.gz";
const directories: string[] = [];
const sessionIds: number[] = [];


beforeAll(() => initServerGameAdapters(developmentReleaseFeatures));
afterEach(async () => {
  for (const id of sessionIds.splice(0)) await deleteSession(id);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function canonicalCapture(frames: Buffer[]): Buffer {
  return Buffer.concat([
    encodeMetaFrame(frames.length),
    ...frames.flatMap((frame) => [encodeFrameLength(frame.length), frame]),
  ]);
}

function packetEvidence(path: string) {
  return readRecordedTelemetry("lmu", path).packets.map((packet) => ({
    lap: packet.LapNumber,
    distance: packet.DistanceTraveled,
    carId: packet.lmu?.carId,
    trackId: packet.lmu?.trackId,
  }));
}

describe("LMU capture containers", () => {
  test("plays sparse RaceIQ captures and raw dump files", async () => {
    const frames = fixtureFrames(readFileSync("packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-grid-2026-10-22.bin.gz"), "lmu").map((record) => record.bytes);
    const header = Buffer.alloc(16);
    header.write("LMUQDMP\0", "ascii");
    header.writeUInt32LE(1, 8);
    header.writeUInt32LE(frames.length, 12);
    const dump = Buffer.concat([header, ...frames.flatMap((frame) => {
      const prefix = Buffer.alloc(5);
      prefix.writeUInt32LE(frame.length, 1);
      return [prefix, frame];
    })]);
    expect(hasLMUDumpMagic(dump)).toBe(true);
    const canonical = canonicalCapture(frames);
    expect(hasLMUDumpMagic(canonical)).toBe(false);

    const directory = mkdtempSync(join(tmpdir(), "raceiq-lmu-containers-"));
    directories.push(directory);
    const paths = {
      dump: join(directory, "lmu-dump.bin"),
      dumpGzip: join(directory, "lmu-dump.bin.gz"),
      canonical: join(directory, "lmu-canonical.bin"),
      canonicalGzip: join(directory, "lmu-canonical.bin.gz"),
      sparse: join(directory, "lmu-sparse.bin"),
      sparseGzip: join(directory, "lmu-sparse.bin.gz"),
    };
    writeFileSync(paths.dump, dump);
    writeFileSync(paths.dumpGzip, gzipSync(dump));
    writeFileSync(paths.canonical, canonical);
    writeFileSync(paths.canonicalGzip, gzipSync(canonical));
    const recorder = new SparseSessionRecorder("lmu");
    recorder.start(paths.sparse);
    for (const frame of frames) recorder.writeRecord(frame);
    await recorder.stop();
    writeFileSync(paths.sparseGzip, gzipSync(readFileSync(paths.sparse)));

    const expected = packetEvidence(paths.sparse);
    expect(expected.length).toBe(frames.length);
    expect(packetEvidence(paths.sparseGzip)).toEqual(expected);
    expect(packetEvidence(paths.dump)).toHaveLength(frames.length);
    expect(packetEvidence(paths.dumpGzip)).toHaveLength(frames.length);
    expect(packetEvidence(paths.canonical)).toHaveLength(frames.length);
    expect(packetEvidence(paths.canonicalGzip)).toHaveLength(frames.length);
    expect(expected[0]).toMatchObject({
      carId: expect.any(String),
      trackId: expect.any(String),
    });
  }, 60_000);

  test("retained LMU imports publish replayable player lap chunks", async () => {
    const frames = fixtureFrames(readFileSync(fixturePath), "lmu").map((record) => record.bytes);
    const imported = await importSessionFrames(frames, "lmu", {
      requireLaps: true,
      notifyDriverProfile: false,
      opponentRetention: "retained",
    });
    sessionIds.push(...imported.sessionIds);
    expect(imported.laps.length).toBeGreaterThan(0);
    for (const sessionId of imported.sessionIds) {
      const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
      expect(session?.captureManifestFile).toBeTruthy();
      const manifest = await loadCaptureManifest(session!.captureManifestFile!);
      expect(manifest.version).toBe(3);
      const sessionLaps = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
      const lapChunks = manifest.chunks.filter((chunk) => chunk.kind === "lap");
      expect(lapChunks).toHaveLength(sessionLaps.length);
      for (const lap of sessionLaps) {
        const chunk = lapChunks.find((candidate) => candidate.lapId === String(lap.id));
        expect(chunk).toBeDefined();
        expect(lap.captureChunkId).toBe(chunk!.id);
        expect(lap.sourceFrameStart).toBe(chunk!.firstOrdinal);
        expect(lap.sourceFrameCount).toBe(lap.rawFrameCount);
        const replay = await queryLapTelemetryBySemanticId(lap.id, ["fuel.virtual-energy"]);
        expect(replay).not.toBeNull();
        expect(replay!.envelopes).toHaveLength(lap.rawFrameCount!);
      }
    }
  }, 120_000);

  for (const nativeBoundary of [false, true]) {
    test(`recorder rekeys ${nativeBoundary ? "preserve a real simulator session boundary" : "do not split one simulator session"}`, async () => {
      const frames = fixtureFrames(readFileSync("packages/game-lmu/test/fixtures/sessions/lmu-real-opponents-grid-2026-10-22.bin.gz"), "lmu");
      const expectedKeys = new Set<string>();
      const expectedFrames = new Set<string>();
      async function* source() {
        for (let index = 0; index < frames.length; index++) {
          const original = decodeLMUSourceFrame(frames[index]!.bytes);
          if (!original?.rawSharedMemory || !original.lmuContext) throw new Error("Grid fixture lacks native recording context");
          const memory = Buffer.from(original.rawSharedMemory);
          if (nativeBoundary && index >= 25) memory.writeUInt32LE(original.sessionEvent + 1, LMU_SESSION_EVENT_OFFSET);
          const key = `rekey-${Math.floor(index / 10)}`;
          expectedKeys.add(key);
          const frame = encodeLMUSourceFrame(memory, original.captureTimestampMs, {
            context: {
              ...original.lmuContext,
              key: { ...original.lmuContext.key, sessionKey: key },
              supplemental: original.lmuContext.supplemental.map((entry) => ({ ...entry, sessionKey: key })),
            },
          });
          if (!frame) throw new Error("Unable to encode recording generation");
          expectedFrames.add(createHash("sha256").update(frame).digest("hex"));
          yield frame;
        }
      }
      const imported = await importSessionFrames(source(), "lmu", { notifyDriverProfile: false, opponentRetention: "retained" });
      sessionIds.push(...imported.sessionIds);
      expect(imported.sessionIds).toHaveLength(nativeBoundary ? 2 : 1);
      const actualKeys = new Set<string>();
      const actualFrames = new Set<string>();
      for (const id of imported.sessionIds) {
        const owner = await db.select().from(sessions).where(eq(sessions.id, id)).get();
        if (!owner?.rawFile) throw new Error("Imported session lacks recording");
        for await (const record of iterateSessionCaptureRecordsFromSource({ ...owner, rawFile: owner.rawFile, gameId: "lmu" }, { strict: true })) {
          if (record.kind !== "frame") continue;
          const context = decodeLMUSourceFrame(record.frame)?.lmuContext;
          if (!context) throw new Error("Recorded generation context was lost");
          actualKeys.add(context.key.sessionKey);
          actualFrames.add(createHash("sha256").update(record.frame).digest("hex"));
        }
      }
      // A transition frame can also be retained as the previous session's context.
      expect(actualFrames).toEqual(expectedFrames);
      expect(actualKeys).toEqual(expectedKeys);
    });
  }
});
