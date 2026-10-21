/**
 * Raw binary storage, byte offsets, and non-destructive session reprocessing.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { insertTune } from "@raceiq/backend-core/db/tune-queries";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRecorder } from "@raceiq/capture-formats/session/recorder";
import {
  META_FRAME_MAGIC,
  decompressIfGzipSync,
  encodeMetaFrame,
  iterateSessionCaptureRecords,
  SESSION_SEGMENT_BOUNDARY,
  SESSION_SEGMENT_CONTEXT,
  SESSION_SEGMENT_CONTEXT_END,
} from "@raceiq/capture-formats/session/framing";
import { reprocessSession } from "@raceiq/backend-core/session-capture/reprocess";
import { db } from "@raceiq/backend-core/db/index";
import { sessions, laps } from "@raceiq/backend-core/db/schema";
import { eq } from "drizzle-orm";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { countStaleSessions, getStaleSessions } from "@raceiq/backend-core/db/session-queries";
import { sessionRoutes } from "../../src/routes/session-routes";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { executeSessionCleanup } from "@raceiq/backend-core/session-capture/session-cleanup";
import { combineRecordingParts } from "@raceiq/backend-core/session-capture/combine-recording-parts";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";

function* seedCaptureFrames(bytes: Buffer) {
  for (const record of iterateSessionCaptureRecords(bytes)) {
    if (record.kind === "frame") {
      yield record.frameTimeMs === undefined
        ? record.frame
        : { frame: record.frame, frameTimeMs: record.frameTimeMs };
    } else if (record.kind === "segment-boundary") {
      yield SESSION_SEGMENT_BOUNDARY;
    } else if (record.kind === "segment-context") {
      yield SESSION_SEGMENT_CONTEXT;
    } else if (record.kind === "segment-context-end") {
      yield SESSION_SEGMENT_CONTEXT_END;
    }
  }
}
initGameAdapters();
initServerGameAdapters();

// ── SessionRecorder: meta frame + byte offset ─────────────────────────────────────

describe("SessionRecorder meta frame", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("writeMetaFrame writes fixed 12-byte header with frame count", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new SessionRecorder();
    recorder.start(join(tmpDir, "session.bin"));

    recorder.writeMetaFrame();
    recorder.writeRecord(Buffer.from([0x01, 0x02]));
    recorder.writeRecord(Buffer.from([0x03, 0x04]));
    await recorder.stop();

    const buf = Buffer.from(await Bun.file(recorder.path!).arrayBuffer());
    expect(buf.readUInt32LE(0)).toBe(META_FRAME_MAGIC);
    expect(buf.readUInt32LE(4)).toBe(4); // payload length always 4
    expect(buf.readUInt32LE(8)).toBe(2); // frame count patched on stop()
  });

  test("getCurrentByteOffset starts at 0 before any writes", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new SessionRecorder();
    recorder.start(join(tmpDir, "session.bin"));
    expect(recorder.getCurrentByteOffset()).toBe(0);
    recorder.stop();
  });

  test("getCurrentByteOffset tracks written bytes", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new SessionRecorder();
    recorder.start(join(tmpDir, "session.bin"));

    // meta frame: 4 (magic) + 4 (len) + 4 (count) = 12 bytes
    recorder.writeMetaFrame();
    expect(recorder.getCurrentByteOffset()).toBe(12);

    // packet: 4 (len prefix) + 3 (payload) = 7 bytes
    recorder.writeRecord(Buffer.from([0x01, 0x02, 0x03]));
    expect(recorder.getCurrentByteOffset()).toBe(19);

    await recorder.stop();
  });

  test("byte offset after meta frame matches where first real packet is written", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-test-"));
    const recorder = new SessionRecorder();
    recorder.start(join(tmpDir, "session.bin"));

    recorder.writeMetaFrame();
    const offsetAfterMeta = recorder.getCurrentByteOffset(); // always 12

    const pkt = Buffer.from([0xAA, 0xBB]);
    recorder.writeRecord(pkt);
    await recorder.stop();

    // Verify the first packet's length prefix sits at offsetAfterMeta in the file
    const buf = Buffer.from(await Bun.file(recorder.path!).arrayBuffer());
    expect(buf.readUInt32LE(offsetAfterMeta)).toBe(pkt.length);
    expect(buf.subarray(offsetAfterMeta + 4, offsetAfterMeta + 4 + pkt.length)).toEqual(pkt);
  });
});

// ── reprocessSession ──────────────────────────────────────────────────────────

describe("reprocessSession", () => {
  let tmpDir: string;
  let sessionId: number;

  beforeEach(() => {
    const capturesDir = join(resolveDataDir(), "sessions");
    mkdirSync(capturesDir, { recursive: true });
    tmpDir = mkdtempSync(join(capturesDir, "reprocess-test-"));
  });

  afterEach(async () => {
    if (sessionId) {
      await db.delete(laps).where(eq(laps.sessionId, sessionId)).run();
      await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    }
    rmSync(tmpDir, { recursive: true, force: true });
    sessionId = 0;
  });

  async function insertTestSession(rawFile: string | null, lapDetectorVersion?: string): Promise<number> {
    const row = await db
      .insert(sessions)
      .values({ carId: "1", trackId: "1", gameId: "fm-2023", rawFile, lapDetectorVersion: lapDetectorVersion ?? null })
      .returning({ id: sessions.id })
      .get();
    return row!.id;
  }

  async function insertTestLap(
    sessId: number,
    lapNumber: number,
    notes?: string,
  ): Promise<void> {
    await db.insert(laps).values({
      sessionId: sessId,
      lapNumber,
      lapTime: 90.0,
      isValid: true,
      notes: notes ?? null,
    }).run();
  }

  function emptyBin(path: string): void {
    writeFileSync(path, encodeMetaFrame());
  }

  test("throws if session has no raw file", async () => {
    sessionId = await insertTestSession(null);
    await expect(reprocessSession(sessionId)).rejects.toThrow("no raw file");
  });

  test("throws if session does not exist", async () => {
    await expect(reprocessSession(999999)).rejects.toThrow();
  });


  test("preserves existing laps when replay detects no recoverable laps", async () => {
    const binPath = join(tmpDir, "session.bin");
    emptyBin(binPath);
    sessionId = await insertTestSession(binPath, "0.9.0");
    await insertTestLap(sessionId, 1, "keep first annotation");
    await insertTestLap(sessionId, 2, "keep second annotation");
    const before = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
    await expect(reprocessSession(sessionId)).rejects.toThrow();
    expect(await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all()).toEqual(before);
    expect(await db.select().from(sessions).where(eq(sessions.id, sessionId)).get()).toMatchObject({
      lapDetectorVersion: "0.9.0",
    });
  });



  test("rejects truncated frames without changing saved laps or repair marker", async () => {
    const binPath = join(tmpDir, "session.bin");
    const truncated = Buffer.from([10, 0, 0, 0, 0xAA, 0xBB]);
    writeFileSync(binPath, Buffer.concat([encodeMetaFrame(1), truncated]));
    sessionId = await insertTestSession(binPath, "0.9.0");
    await insertTestLap(sessionId, 1, "keep truncated capture annotation");
    const before = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
    await expect(reprocessSession(sessionId)).rejects.toThrow();
    expect(await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all()).toEqual(before);
    expect(await db.select().from(sessions).where(eq(sessions.id, sessionId)).get()).toMatchObject({
      lapDetectorVersion: "0.9.0",
    });
  });

  test("throws with descriptive error when raw file is missing from disk", async () => {
    const binPath = join(tmpDir, "does-not-exist.bin");
    // Do NOT create the file — it must be absent
    sessionId = await insertTestSession(binPath, "0.9.0");

    await expect(reprocessSession(sessionId)).rejects.toThrow("raw file not found");
  });

  test("returns 410 when reprocess capture is missing from disk", async () => {
    const binPath = join(tmpDir, "does-not-exist.bin");
    sessionId = await insertTestSession(binPath, "0.9.0");

    const response = await sessionRoutes.request(
      `/api/sessions/${sessionId}/reprocess`,
      { method: "POST" },
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: `Session ${sessionId} raw file not found: ${binPath}`,
    });
  });

  test("returns 410 when session has no raw capture", async () => {
    sessionId = await insertTestSession(null, "0.9.0");

    const response = await sessionRoutes.request(
      `/api/sessions/${sessionId}/reprocess`,
      { method: "POST" },
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: `Session ${sessionId} has no raw file to reprocess`,
    });
  });

  test("returns 404 when reprocess session does not exist", async () => {
    sessionId = await insertTestSession(null, "0.9.0");
    const missingSessionId = sessionId;
    await db.delete(sessions).where(eq(sessions.id, missingSessionId)).run();
    sessionId = 0;

    const response = await sessionRoutes.request(
      `/api/sessions/${missingSessionId}/reprocess`,
      { method: "POST" },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: `Session ${missingSessionId} not found`,
    });
  });

  test("AC EVO Tourist repair is repeatable and preserves session metadata", async () => {
    const binPath = join(tmpDir, "ac-evo-tourist.bin");
    const recording = await combineRecordingParts([
      "test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part1",
      "test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part2",
    ]);
    try {
      const bytes = decompressIfGzipSync(Buffer.from(readFileSync(recording.path)));
      const converted = await convertSeedFramesToSparse("ac-evo", seedCaptureFrames(bytes));
      try {
        copyFileSync(converted.path, binPath);
      } finally {
        converted.cleanup();
      }
    } finally {
      recording.cleanup();
    }
    const row = await db.insert(sessions).values({
      gameId: "ac-evo",
      carId: "test-car",
      trackId: "test-track",
      rawFile: binPath,
      captureFormatVersion: 1,
      notes: "Tourist repair metadata",
      isFavorite: true,
    }).returning({ id: sessions.id }).get();
    sessionId = row!.id;

    await reprocessSession(sessionId);
    const lapsBefore = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
    expect(lapsBefore.length).toBeGreaterThan(0);
    const selected = lapsBefore.find((lap) => lap.rawByteOffset != null && (lap.rawFrameCount ?? 0) > 0)!;
    const tuneId = await insertTune({
      gameId: "ac-evo", name: "Repair tune", author: "test", carId: "test-car",
      category: "baseline", description: "", settings: "{}",
    });
    await db.update(laps).set({
      isFavorite: true,
      notes: "Tourist window",
      tuneId,
    }).where(eq(laps.id, selected.id)).run();
    // Force replacement strategy; matching must come from source windows.
    await insertTestLap(sessionId, Math.max(...lapsBefore.map((lap) => lap.lapNumber)) + 1);

    await reprocessSession(sessionId);
    const afterFirst = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
    expect(afterFirst.filter((lap) => lap.notes === "Tourist window")).toHaveLength(1);
    expect(afterFirst.find((lap) => lap.notes === "Tourist window")?.isFavorite).toBe(true);
    expect(afterFirst.find((lap) => lap.notes === "Tourist window")?.tuneId).toBe(tuneId);
    expect(afterFirst.some((lap) => lap.lapNumber === Math.max(...lapsBefore.map((lap) => lap.lapNumber)) + 1)).toBe(false);
    const windows = afterFirst.map(({ rawByteOffset, rawFrameCount }) => [rawByteOffset, rawFrameCount]);

    await reprocessSession(sessionId);
    const afterSecond = await db.select().from(laps).where(eq(laps.sessionId, sessionId)).all();
    expect(afterSecond.map(({ rawByteOffset, rawFrameCount }) => [rawByteOffset, rawFrameCount])).toEqual(windows);
    expect(afterSecond.filter((lap) => lap.notes === "Tourist window")).toHaveLength(1);
    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(session).toMatchObject({ gameId: "ac-evo", trackId: '["Nurburgring","Touristenfahrten"]', notes: "Tourist repair metadata", isFavorite: true });
    expect(session?.carId).not.toBe("test-car");
  }, { timeout: 180_000 });
});

// ── countStaleSessions ────────────────────────────────────────────────────────

describe("countStaleSessions", () => {
  const insertedIds: number[] = [];
  const detectorId = "lapdetector_v1";
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-stale-sessions-"));
  });

  afterEach(async () => {
    for (const id of insertedIds) {
      await db.delete(laps).where(eq(laps.sessionId, id)).run();
      await db.delete(sessions).where(eq(sessions.id, id)).run();
    }
    insertedIds.length = 0;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function insertSession(
    rawFile: string | null,
    lapDetectorVersion: string | null,
    gameId = "fm-2023",
    captureFormatVersion: number | null = 1,
    source: string | null = null,
  ): Promise<number> {
    const row = await db
      .insert(sessions)
      .values({ carId: "1", trackId: "1", gameId, rawFile, lapDetectorVersion, captureFormatVersion, source })
      .returning({ id: sessions.id })
      .get();
    const id = row!.id;
    insertedIds.push(id);
    return id;
  }

  test("counts only available supported raw sessions with stale detector versions", async () => {
    const beforeCount = await countStaleSessions(detectorId, ["fm-2023"]);
    const staleOldPath = join(tmpDir, "stale-old.bin");
    const staleNullPath = join(tmpDir, "stale-null.bin");
    const currentPath = join(tmpDir, "current.bin");
    const unsupportedPath = join(tmpDir, "unsupported.bin");
    writeFileSync(staleOldPath, Buffer.alloc(16));
    writeFileSync(staleNullPath, Buffer.alloc(16));
    writeFileSync(currentPath, Buffer.alloc(16));
    writeFileSync(unsupportedPath, Buffer.alloc(16));

    await insertSession(staleOldPath, "lapdetector_v0");
    await insertSession(staleNullPath, null);
    await insertSession(join(tmpDir, "missing.bin"), "lapdetector_v0");
    await insertSession(currentPath, detectorId);
    await insertSession(unsupportedPath, "lapdetector_v0", "lmu");
    await insertSession(unsupportedPath, "lapdetector_v0", "fm-2023", null);
    await insertSession(unsupportedPath, "lapdetector_v0", "fm-2023", null, "motec");
    await insertSession(null, null);

    const afterCount = await countStaleSessions(detectorId, ["fm-2023"]);
    expect(afterCount - beforeCount).toBe(3);
  });

  test("getStaleSessions returns only raw sessions with stale detector versions", async () => {
    const baselineIds = await getStaleSessions(detectorId, ["fm-2023"]);
    const baselineSet = new Set(baselineIds);
    const staleOldPath = join(tmpDir, "stale-old.bin");
    const staleNullPath = join(tmpDir, "stale-null.bin");
    const currentPath = join(tmpDir, "current.bin");
    const unsupportedPath = join(tmpDir, "unsupported.bin");
    writeFileSync(staleOldPath, Buffer.alloc(16));
    writeFileSync(staleNullPath, Buffer.alloc(16));
    writeFileSync(currentPath, Buffer.alloc(16));
    writeFileSync(unsupportedPath, Buffer.alloc(16));

    const staleRawOldVersion = await insertSession(staleOldPath, "lapdetector_v0");
    const staleRawNullVersion = await insertSession(staleNullPath, null);
    const missingRaw = await insertSession(join(tmpDir, "missing.bin"), "lapdetector_v0");
    const currentVersion = await insertSession(currentPath, detectorId);
    const noRaw = await insertSession(null, null);
    const unsupportedGame = await insertSession(unsupportedPath, "lapdetector_v0", "lmu");
    const legacyCapture = await insertSession(unsupportedPath, "lapdetector_v0", "fm-2023", null);
    const motecCapture = await insertSession(unsupportedPath, "lapdetector_v0", "fm-2023", null, "motec");

    const allIds = await getStaleSessions(detectorId, ["fm-2023"]);
    const insertedIdsOnly = allIds.filter((id) => !baselineSet.has(id));

    expect(insertedIdsOnly).toHaveLength(3);
    expect(insertedIdsOnly).toContain(staleRawOldVersion);
    expect(insertedIdsOnly).toContain(staleRawNullVersion);
    expect(insertedIdsOnly).toContain(motecCapture);
    expect(insertedIdsOnly).not.toContain(missingRaw);
    expect(insertedIdsOnly).not.toContain(currentVersion);
    expect(insertedIdsOnly).not.toContain(noRaw);
    expect(insertedIdsOnly).not.toContain(unsupportedGame);
    expect(insertedIdsOnly).not.toContain(legacyCapture);
  });
});
