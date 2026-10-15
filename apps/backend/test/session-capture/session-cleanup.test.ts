import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as captureFs from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { eq, inArray } from "drizzle-orm";
import { db, client } from "@raceiq/backend-core/db/index";
import { laps, sessions, sessionCaptureSplitJobs } from "@raceiq/backend-core/db/schema";
import { SessionCaptureActiveError, deleteSession, setSessionFavorite, setLapFavorite } from "@raceiq/backend-core/db/session-queries";
import { runUserCompressionNow } from "@raceiq/backend-core/session-capture/compressor";
import { withSessionCaptureMaintenanceLock } from "@raceiq/backend-core/session-capture/cleanup";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { executeSessionCleanup, previewSessionCleanup, SessionCleanupBusyError } from "@raceiq/backend-core/session-capture/session-cleanup";
import { reprocessSession, SessionRawFileMissingError } from "@raceiq/backend-core/session-capture/reprocess";
import * as dashboardProcessor from "@raceiq/backend-core/session-capture/dashboard-processor";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";

const OLD_DATE = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
const RECENT_DATE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

const createdSessionIds: number[] = [];
const createdLapIds: number[] = [];
const temporaryDirectories: string[] = [];

async function createSession(options: { rawFile: string | null; createdAt?: string; isFavorite?: boolean }): Promise<number> {
  const row = await db
    .insert(sessions)
    .values({
      gameId: "fm-2023",
      carId: "1",
      trackId: "1",
      rawFile: options.rawFile,
      createdAt: options.createdAt ?? OLD_DATE,
      isFavorite: options.isFavorite ?? false,
      lapDetectorVersion: "lapdetector_v1",
    })
    .returning({ id: sessions.id })
    .get();
  createdSessionIds.push(row.id);
  return row.id;
}

async function createLap(sessionId: number, isFavorite = false): Promise<number> {
  const row = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber: 1,
      lapTime: 90,
      isValid: true,
      isFavorite,
    })
    .returning({ id: laps.id })
    .get();
  createdLapIds.push(row.id);
  return row.id;
}

function capturePath(name: string): string {
  const directory = join(resolveDataDir(), "sessions", `cleanup-edge-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return join(directory, name);
}

afterEach(async () => {
  if (createdLapIds.length) {
    await db.delete(laps).where(inArray(laps.id, createdLapIds)).run();
    createdLapIds.length = 0;
  }
  if (createdSessionIds.length) {
    await db.delete(sessions).where(inArray(sessions.id, createdSessionIds)).run();
    createdSessionIds.length = 0;
  }
  rmSync(join(resolveDataDir(), "recording-layout-migration.json"), { force: true });
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session cleanup edge cases", () => {
  test("does not delete capture while layout migration is pending", async () => {
    const path = capturePath("migration-pending.bin");
    writeFileSync(path, Buffer.from("pending migration capture"));
    const sessionId = await createSession({ rawFile: path });
    writeFileSync(join(resolveDataDir(), "recording-layout-migration.json"), JSON.stringify({
      version: 1,
      root: resolveRecordingDirectory(),
      destination: resolveRecordingDirectory(),
      phase: "organizing",
      entries: [],
      progress: { status: "running", done: 0, total: 0, migrated: 0, failed: 0, error: null },
    }));

    await expect(executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] })).rejects.toBeInstanceOf(SessionCleanupBusyError);
    expect(existsSync(path)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(path);
  });
  test("age mode excludes recent sessions and preview does not mutate files or metadata", async () => {
    const oldPath = capturePath("old.bin");
    const recentPath = capturePath("recent.bin");
    writeFileSync(oldPath, Buffer.from("old capture"));
    writeFileSync(recentPath, Buffer.from("recent capture"));
    const oldId = await createSession({ rawFile: oldPath });
    const oldLapId = await createLap(oldId);
    const recentId = await createSession({ rawFile: recentPath, createdAt: RECENT_DATE });

    const preview = await previewSessionCleanup({ mode: "older-than", olderThanDays: 7 });

    expect(preview.candidateSessionIds).toEqual([oldId]);
    expect(preview.fileCount).toBe(1);
    expect(preview.reclaimableBytes).toBe(Buffer.byteLength("old capture"));
    expect(existsSync(oldPath)).toBe(true);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, oldId)).get())?.rawFile).toBe(oldPath);
    expect(preview.candidateSessionIds).not.toContain(recentId);
    expect(preview.games).toHaveLength(1);
    expect(preview.games[0]).toMatchObject({
      gameId: "fm-2023",
      sessionCount: 1,
      reclaimableBytes: Buffer.byteLength("old capture"),
      sessions: [
        {
          id: oldId,
          laps: [{ id: oldLapId, sessionId: oldId, lapNumber: 1, lapTime: 90, isValid: true }],
        },
      ],
    });
  });

  test("selected mode deduplicates IDs and reports missing selections as unavailable", async () => {
    const path = capturePath("selected.bin");
    writeFileSync(path, Buffer.from("selected"));
    const sessionId = await createSession({ rawFile: path });

    const preview = await previewSessionCleanup({ mode: "selected", sessionIds: [sessionId, sessionId, 999999999] });

    expect(preview.candidateSessionIds).toEqual([sessionId]);
    expect(preview.unavailableSessionIds).toContain(999999999);
  });

  test("favourite session and favourite lap protect complete capture in age cleanup", async () => {
    const sessionPath = capturePath("favorite-session.bin");
    const lapPath = capturePath("favorite-lap.bin");
    writeFileSync(sessionPath, Buffer.from("session"));
    writeFileSync(lapPath, Buffer.from("lap"));
    const favoriteSessionId = await createSession({ rawFile: sessionPath, isFavorite: true });
    const lapProtectedSessionId = await createSession({ rawFile: lapPath });
    await createLap(lapProtectedSessionId, true);

    const preview = await previewSessionCleanup({ mode: "older-than", olderThanDays: 7 });

    expect(preview.candidateSessionIds).toEqual([]);
    expect(preview.protectedSessionIds.sort()).toEqual([favoriteSessionId, lapProtectedSessionId].sort());
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(lapPath)).toBe(true);
  });

  test("shared capture is all-or-nothing when one reference is not selected", async () => {
    const path = capturePath("shared.bin");
    writeFileSync(path, Buffer.from("shared capture"));
    const selectedId = await createSession({ rawFile: path });
    const unselectedId = await createSession({ rawFile: path });

    const preview = await previewSessionCleanup({ mode: "selected", sessionIds: [selectedId] });

    expect(preview.candidateSessionIds).toEqual([]);
    expect(preview.unavailableSessionIds).toContain(selectedId);
    expect(preview.unavailableSessionIds).not.toContain(unselectedId);
  });

  test("rejects captures outside owned data directory", async () => {
    const outsideDirectory = mkdtempSync(join(tmpdir(), "raceiq-cleanup-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const path = join(outsideDirectory, "outside.bin");
    writeFileSync(path, Buffer.from("outside"));
    const sessionId = await createSession({ rawFile: path });

    const preview = await previewSessionCleanup({ mode: "selected", sessionIds: [sessionId] });

    expect(preview.candidateSessionIds).toEqual([]);
    expect(preview.unavailableSessionIds).toEqual([sessionId]);
    expect(existsSync(path)).toBe(true);
  });

  test("clears missing capture path while retaining session and lap metadata", async () => {
    const path = capturePath("missing.bin");
    const sessionId = await createSession({ rawFile: path });
    const lapId = await createLap(sessionId);

    const preview = await previewSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
    expect(preview.candidateSessionIds).toEqual([sessionId]);
    expect(preview.fileCount).toBe(0);
    expect(preview.reclaimableBytes).toBe(0);
    expect(preview.games[0]?.sessions.map((session) => session.id)).toEqual([sessionId]);
    const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });

    expect(result.cleanedSessionIds).toEqual([sessionId]);
    expect(result.freedBytes).toBe(0);
    expect(result.deletedFiles).toBe(0);
    expect(result.failed).toEqual([]);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBeNull();
    expect((await db.select({ id: laps.id }).from(laps).where(eq(laps.id, lapId)).get())?.id).toBe(lapId);
  });

  test("deletes capture but retains metadata and lap rows", async () => {
    const path = capturePath("successful.bin");
    writeFileSync(path, Buffer.from("successful capture"));
    const sessionId = await createSession({ rawFile: path });
    const lapId = await createLap(sessionId);

    const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });

    expect(result.cleanedSessionIds).toEqual([sessionId]);
    expect(result.deletedFiles).toBe(1);
    expect(result.freedBytes).toBe(Buffer.byteLength("successful capture"));
    expect(existsSync(path)).toBe(false);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBeNull();
    expect((await db.select({ id: laps.id }).from(laps).where(eq(laps.id, lapId)).get())?.id).toBe(lapId);
  });

  test("rolls back database path and file when clearing raw_file fails", async () => {
    const path = capturePath("rollback.bin");
    const payload = Buffer.from("rollback capture");
    writeFileSync(path, payload);
    const sessionId = await createSession({ rawFile: path });
    const trigger = `cleanup_update_failure_${sessionId}`;
    const lapId = await createLap(sessionId);
    await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: join(dirname(path), "rollback-manifest.json") })
      .where(eq(sessions.id, sessionId)).run();
    await db.update(laps).set({ captureChunkId: "rollback-chunk", sourceFrameStart: 4, sourceFrameCount: 7 })
      .where(eq(laps.id, lapId)).run();
    await client.execute(`
      CREATE TRIGGER ${trigger} BEFORE UPDATE OF raw_file ON sessions
      WHEN OLD.id = ${sessionId}
      BEGIN SELECT RAISE(ABORT, 'Injected cleanup update failure'); END
    `);
    try {
      const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
      expect(result.cleanedSessionIds).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.sessionIds).toEqual([sessionId]);
    } finally {
      await client.execute(`DROP TRIGGER ${trigger}`);
    }

    expect(await db.select({
      captureChunkId: laps.captureChunkId,
      sourceFrameStart: laps.sourceFrameStart,
      sourceFrameCount: laps.sourceFrameCount,
    }).from(laps).where(eq(laps.id, lapId)).get()).toEqual({
      captureChunkId: "rollback-chunk",
      sourceFrameStart: 4,
      sourceFrameCount: 7,
    });
    expect(readFileSync(path)).toEqual(payload);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(path);
  });

  test("restores split readiness when source deletion fails after clearing references", async () => {
    const path = capturePath("job-rollback.bin");
    writeFileSync(path, "retained telemetry");
    const sessionId = await createSession({ rawFile: path });
    await db.insert(sessionCaptureSplitJobs).values({
      sessionId, jobId: crypto.randomUUID(), pendingSourceRevision: "revision",
      sourcePath: path, status: "ready", attemptId: 2, sequence: 7,
    }).run();
    const originalJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get();
    const originalUnlink = captureFs.unlink;
    const unlink = spyOn(captureFs, "unlink").mockImplementation(async (file) => {
      if (String(file).startsWith(`${path}.cleanup-`)) throw new Error("Injected staged source deletion failure");
      return originalUnlink(file);
    });
    try {
      const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
      expect(result.cleanedSessionIds).toEqual([]);
      expect(result.failed).toEqual([{ sessionIds: [sessionId], message: "Injected staged source deletion failure" }]);
      expect(readFileSync(path, "utf8")).toBe("retained telemetry");
      expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(path);
      expect(await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get()).toEqual(originalJob);
    } finally {
      unlink.mockRestore();
    }
  });

  test("preserves published telemetry when missing-source cleanup fails before deleting artifacts", async () => {
    const path = capturePath("missing-original.bin");
    const manifest = join(dirname(path), "preserved-manifest.json");
    const chunk = join(dirname(path), "preserved-lap.bin");
    writeFileSync(chunk, "readable lap telemetry");
    const sessionId = await createSession({ rawFile: path });
    const lapId = await createLap(sessionId);
    writeFileSync(manifest, JSON.stringify({
      version: 3, gameId: "fm-2023", sourceRevision: "revision", sourceByteLength: 21, sourceRecordCount: 1,
      chunks: [{
        id: "lap", kind: "lap", lapId: String(lapId), lapNumber: 1, path: "preserved-lap.bin",
        byteLength: Buffer.byteLength("readable lap telemetry"), firstOrdinal: 0, recordCount: 1,
        sourceStart: 0, sourceEnd: 1, sourceByteStart: 12, sourceByteEnd: 21,
        ownedFrameByteOffset: 12, ownedFrameCount: 1,
      }],
    }));
    await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: manifest }).where(eq(sessions.id, sessionId)).run();
    await db.update(laps).set({ captureChunkId: "lap", sourceFrameStart: 0, sourceFrameCount: 1 }).where(eq(laps.id, lapId)).run();
    await db.insert(sessionCaptureSplitJobs).values({
      sessionId, jobId: crypto.randomUUID(), pendingSourceRevision: "revision", sourcePath: path, status: "ready",
    }).run();
    const originalJob = await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get();
    const checkpoint = spyOn(dashboardProcessor, "releaseDashboardCaptureCheckpoint")
      .mockImplementationOnce(async () => { throw new Error("Injected post-clear dashboard failure"); });
    try {
      const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
      expect(result.cleanedSessionIds).toEqual([]);
      expect(result.failed).toEqual([{ sessionIds: [sessionId], message: "Injected post-clear dashboard failure" }]);
      expect((await db.select({ manifest: sessions.captureManifestFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.manifest).toBe(manifest);
      expect((await db.select({ chunk: laps.captureChunkId }).from(laps).where(eq(laps.id, lapId)).get())?.chunk).toBe("lap");
      expect(await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get()).toEqual(originalJob);
      expect(readFileSync(chunk, "utf8")).toBe("readable lap telemetry");
    } finally {
      checkpoint.mockRestore();
    }
  });
  for (const favorite of ["session", "lap"] as const) {
    test(`serializes ${favorite} favorite write before cleanup planning`, async () => {
      const path = capturePath(`favorite-race-${favorite}.bin`);
      writeFileSync(path, Buffer.from("favorite race"));
      const sessionId = await createSession({ rawFile: path });
      const lapId = await createLap(sessionId);

      const gate = Promise.withResolvers<void>();
      const held = withSessionCaptureMaintenanceLock(() => gate.promise);
      const updateFavorite = favorite === "session" ? setSessionFavorite(sessionId, true) : setLapFavorite(lapId, true);
      const cleanup = executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
      gate.resolve();

      await held;
      expect(await updateFavorite).toBe(true);
      const result = await cleanup;

      expect(result.candidateSessionIds).toEqual([]);
      expect(result.protectedSessionIds).toContain(sessionId);
      expect(existsSync(path)).toBe(true);
      expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(path);
    });
  }

  test("serializes reprocessing after cleanup without restoring deleted raw_file", async () => {
    const path = capturePath("reprocess-race.bin");
    writeFileSync(path, Buffer.from("reprocess race"));
    const sessionId = await createSession({ rawFile: path });

    const gate = Promise.withResolvers<void>();
    const held = withSessionCaptureMaintenanceLock(() => gate.promise);
    const cleanup = executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
    const reprocess = reprocessSession(sessionId);
    gate.resolve();

    await held;
    const result = await cleanup;
    expect(result.cleanedSessionIds).toEqual([sessionId]);
    await expect(reprocess).rejects.toBeInstanceOf(SessionRawFileMissingError);
    expect(existsSync(path)).toBe(false);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBeNull();
  });

  test("serializes compression behind cleanup so cleaned capture is not restored", async () => {
    const path = capturePath("overlap.bin");
    writeFileSync(path, Buffer.from("overlap capture"));
    const sessionId = await createSession({ rawFile: path });

    const gate = Promise.withResolvers<void>();
    const held = withSessionCaptureMaintenanceLock(() => gate.promise);
    const cleanup = executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
    const compression = runUserCompressionNow();
    gate.resolve();

    await held;
    await cleanup;
    await compression;

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.gz`)).toBe(false);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBeNull();
  });
  test("removes owned bundle manifest and members with cleaned source", async () => {
    const directory = dirname(capturePath("bundle.bin"));
    const rawFile = join(directory, "bundle.bin");
    const manifestFile = join(directory, "manifest.json");
    const chunkFile = join(directory, "lap-1.bin");
    writeFileSync(rawFile, Buffer.from("raw capture"));
    writeFileSync(chunkFile, Buffer.from("lap capture"));
    writeFileSync(manifestFile, JSON.stringify({
      version: 3,
      gameId: "fm-2023",
      sourceRevision: "revision",
      sourceByteLength: 0,
      sourceRecordCount: 0,
      chunks: [{
        id: "lap-1", kind: "lap", lapId: "1", lapNumber: 1, path: "lap-1.bin",
        byteLength: 10, firstOrdinal: 0, recordCount: 0, sourceStart: 0, sourceEnd: 0,
        sourceByteStart: 0, sourceByteEnd: 0,
      }],
    }));
    const sessionId = await createSession({ rawFile });
    const lapId = await createLap(sessionId);
    await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: manifestFile }).where(eq(sessions.id, sessionId)).run();
    await db.update(laps).set({ captureChunkId: "lap-1", sourceFrameStart: 0, sourceFrameCount: 1 }).where(eq(laps.id, lapId)).run();
    await db.insert(sessionCaptureSplitJobs).values({
      sessionId, jobId: crypto.randomUUID(), pendingSourceRevision: "revision",
      sourcePath: rawFile, status: "ready",
    }).run();

    const manifestBytes = Buffer.byteLength(readFileSync(manifestFile, "utf8"));
    const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
    expect(result.deletedFiles).toBe(3);
    expect(result.freedBytes).toBe(Buffer.byteLength("raw capture") + Buffer.byteLength("lap capture") + manifestBytes);

    expect(result.cleanedSessionIds).toContain(sessionId);
    expect(existsSync(rawFile)).toBe(false);
    expect(existsSync(manifestFile)).toBe(false);
    expect(existsSync(chunkFile)).toBe(false);
    expect(await db.select({ captureManifestFile: sessions.captureManifestFile }).from(sessions).where(eq(sessions.id, sessionId)).get()).toEqual({ captureManifestFile: null });
    expect(await db.select({ captureChunkId: laps.captureChunkId }).from(laps).where(eq(laps.id, lapId)).get()).toEqual({ captureChunkId: null });
    expect(await db.select().from(sessionCaptureSplitJobs).where(eq(sessionCaptureSplitJobs.sessionId, sessionId)).get()).toBeUndefined();
  });
  test("reports committed cleanup and accurate bytes when a bundle member cannot be removed", async () => {
    const directory = dirname(capturePath("partial-cleanup.bin"));
    const rawFile = join(directory, "partial-cleanup.bin");
    const manifestFile = join(directory, "manifest.json");
    const chunkFile = join(directory, "lap.bin");
    writeFileSync(rawFile, "raw capture");
    writeFileSync(chunkFile, "retained lap");
    writeFileSync(manifestFile, JSON.stringify({
      version: 3, gameId: "fm-2023", sourceRevision: "partial", sourceByteLength: 0, sourceRecordCount: 0,
      chunks: [{
        id: "lap", kind: "lap", lapId: "1", lapNumber: 1, path: "lap.bin", byteLength: 12,
        firstOrdinal: 0, recordCount: 0, sourceStart: 0, sourceEnd: 0, sourceByteStart: 0, sourceByteEnd: 0,
      }],
    }));
    const manifestBytes = readFileSync(manifestFile).length;
    const sessionId = await createSession({ rawFile });
    const lapId = await createLap(sessionId);
    await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: manifestFile }).where(eq(sessions.id, sessionId)).run();
    await db.update(laps).set({ captureChunkId: "lap" }).where(eq(laps.id, lapId)).run();
    const originalUnlink = captureFs.unlink;
    const unlink = spyOn(captureFs, "unlink").mockImplementation(async (path) => {
      if (path === chunkFile) throw Object.assign(new Error("Injected bundle unlink failure"), { code: "EACCES" });
      return originalUnlink(path);
    });
    try {
      const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
      expect(result.cleanedSessionIds).toContain(sessionId);
      expect(result.deletedFiles).toBe(2);
      expect(result.freedBytes).toBe(Buffer.byteLength("raw capture") + manifestBytes);
      expect(result.failed).toEqual([{ sessionIds: [sessionId], message: expect.stringContaining("Injected bundle unlink failure") }]);
      expect(existsSync(rawFile)).toBe(false);
      expect(existsSync(manifestFile)).toBe(false);
      expect(existsSync(chunkFile)).toBe(true);
      expect(await db.select({ rawFile: sessions.rawFile, layout: sessions.captureLayoutVersion }).from(sessions).where(eq(sessions.id, sessionId)).get())
        .toEqual({ rawFile: null, layout: null });
      expect((await db.select({ chunk: laps.captureChunkId }).from(laps).where(eq(laps.id, lapId)).get())?.chunk).toBeNull();
    } finally {
      unlink.mockRestore();
    }
  });
  test("protects queued split source from session cleanup", async () => {
    const path = capturePath("queued-cleanup.bin");
    writeFileSync(path, Buffer.from("queued cleanup"));
    const sessionId = await createSession({ rawFile: path });
    await db.insert(sessionCaptureSplitJobs).values({
      sessionId,
      jobId: crypto.randomUUID(),
      pendingSourceRevision: "revision",
      sourcePath: path,
      stagingPath: null,
      status: "queued",
    }).run();

    const preview = await previewSessionCleanup({ mode: "selected", sessionIds: [sessionId] });
    const result = await executeSessionCleanup({ mode: "selected", sessionIds: [sessionId] });

    expect(preview.protectedSessionIds).toContain(sessionId);
    expect(result.cleanedSessionIds).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });
  test("keeps queued split source unchanged during manual compression", async () => {
    const path = capturePath("queued-source.bin");
    writeFileSync(path, Buffer.from("queued source"));
    const sessionId = await createSession({ rawFile: path });
    await db.insert(sessionCaptureSplitJobs).values({
      sessionId,
      jobId: crypto.randomUUID(),
      pendingSourceRevision: "revision",
      sourcePath: path,
      stagingPath: null,
      status: "queued",
    }).run();

    await runUserCompressionNow();

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.gz`)).toBe(false);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(path);
  });
  test("deletes shared raw source and bundle only after final session reference", async () => {
    const directory = dirname(capturePath("shared.bin"));
    const rawFile = join(directory, "shared.bin");
    const manifestFile = join(directory, "manifest.json");
    const chunkFile = join(directory, "lap.bin");
    writeFileSync(rawFile, Buffer.from("shared source"));
    writeFileSync(chunkFile, Buffer.from("shared lap"));
    writeFileSync(manifestFile, JSON.stringify({
      version: 3, gameId: "fm-2023", sourceRevision: "revision", sourceByteLength: 0,
      sourceRecordCount: 0,
      chunks: [{
        id: "lap", kind: "lap", lapId: "1", lapNumber: 1, path: "lap.bin",
        byteLength: 10, firstOrdinal: 0, recordCount: 0, sourceStart: 0, sourceEnd: 0,
        sourceByteStart: 0, sourceByteEnd: 0,
      }],
    }));
    const first = await createSession({ rawFile });
    const second = await createSession({ rawFile });
    await db.update(sessions).set({ captureLayoutVersion: 1, captureManifestFile: manifestFile })
      .where(inArray(sessions.id, [first, second])).run();
    await createLap(first);
    await createLap(second);

    await deleteSession(first);
    expect(existsSync(rawFile)).toBe(true);
    expect(existsSync(manifestFile)).toBe(true);
    expect(existsSync(chunkFile)).toBe(true);

    await deleteSession(second);
    expect(existsSync(rawFile)).toBe(false);
    expect(existsSync(manifestFile)).toBe(false);
    expect(existsSync(chunkFile)).toBe(false);
  });

  test("refuses deletion while split attempt owns session", async () => {
    const path = capturePath("active-delete.bin");
    writeFileSync(path, Buffer.from("active source"));
    const sessionId = await createSession({ rawFile: path });
    await db.insert(sessionCaptureSplitJobs).values({
      sessionId, jobId: crypto.randomUUID(), pendingSourceRevision: "revision",
      sourcePath: path, stagingPath: null, status: "splitting",
    }).run();

    await expect(deleteSession(sessionId)).rejects.toBeInstanceOf(SessionCaptureActiveError);
    expect(existsSync(path)).toBe(true);
    expect(await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get()).toBeTruthy();
  });
});
