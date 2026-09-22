import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, inArray } from "drizzle-orm";
import { db, client } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { resolveDataDir } from "../../server/runtime/config/data-dir";
import { executeSessionCleanup, previewSessionCleanup } from "../../server/session-capture/session-cleanup";

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
      carOrdinal: 1,
      trackOrdinal: 1,
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
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("session cleanup edge cases", () => {
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

    expect(readFileSync(path)).toEqual(payload);
    expect((await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get())?.rawFile).toBe(path);
  });
});
