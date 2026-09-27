/**
 * Tests for session-compressor: compression of old .bin files,
 * skipping of new files, and graceful handling of missing files.
 */
import { describe, test, expect, afterEach, beforeEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, db } from "../../server/db/index";
import { sessions } from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { runCompressionNow } from "../../server/session-capture/compressor";
import { cleanupOrphanSessionFiles, withSessionCaptureMaintenanceLock } from "../../server/session-capture/cleanup";
import { resolveDataDir } from "../../server/runtime/config/data-dir";

// Insert a minimal session row. createdAt accepts an ISO string so we can
// back-date it to simulate files older than 24 hours.
async function insertSession(rawFile: string | null, createdAt: string): Promise<number> {
  const result = await db.insert(sessions).values({
    gameId: "fm-2023",
    carOrdinal: 1,
    trackOrdinal: 1,
    rawFile,
    lapDetectorVersion: "lapdetector_v1",
    createdAt,
  }).returning({ id: sessions.id }).get();
  return result.id;
}

async function deleteSession(id: number) {
  await db.delete(sessions).where(eq(sessions.id, id)).run();
}

const OLD_DATE = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
const NEW_DATE = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

describe("session-compressor", () => {
  let tmpDir: string;
  let sessionId: number | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "raceiq-compressor-"));
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (sessionId != null) {
      await deleteSession(sessionId);
      sessionId = null;
    }
  });

  test("compresses old .bin file, deletes original, updates DB path", async () => {
    const binPath = join(tmpDir, "session.bin");
    writeFileSync(binPath, Buffer.from("hello world"));

    sessionId = await insertSession(binPath, OLD_DATE);
    await runCompressionNow();

    const gzPath = `${binPath}.gz`;
    expect(existsSync(gzPath)).toBe(true);
    expect(existsSync(binPath)).toBe(false);

    const row = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.rawFile).toBe(gzPath);
  });

  test("skips .bin files newer than 24 hours", async () => {
    const binPath = join(tmpDir, "new-session.bin");
    writeFileSync(binPath, Buffer.from("new data"));

    sessionId = await insertSession(binPath, NEW_DATE);
    await runCompressionNow();

    expect(existsSync(binPath)).toBe(true);
    expect(existsSync(`${binPath}.gz`)).toBe(false);
  });

  test("skips gracefully when .bin file is missing from disk", async () => {
    const binPath = join(tmpDir, "missing.bin");
    // Don't create the file — just register the path in DB

    sessionId = await insertSession(binPath, OLD_DATE);
    await expect(runCompressionNow()).resolves.toBeUndefined();

    // DB path unchanged (still points to missing .bin)
    const row = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.rawFile).toBe(binPath);
  });

  test("skips already-compressed .bin.gz files", async () => {
    const gzPath = join(tmpDir, "session.bin.gz");
    writeFileSync(gzPath, Buffer.from("already compressed"));

    // rawFile already points to .gz — should not appear as an uncompressed candidate
    sessionId = await insertSession(gzPath, OLD_DATE);
    await runCompressionNow();

    // gz file untouched
    expect(existsSync(gzPath)).toBe(true);
    const row = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.rawFile).toBe(gzPath);
  });

  test("round-trips payloads larger than a stream chunk", async () => {
    const binPath = join(tmpDir, "session.bin");
    const payload = Buffer.alloc(1024 * 1024 + 17);
    for (let index = 0; index < payload.length; index++) {
      payload[index] = index % 251;
    }
    writeFileSync(binPath, payload);

    sessionId = await insertSession(binPath, OLD_DATE);
    await runCompressionNow();

    expect(gunzipSync(readFileSync(`${binPath}.gz`))).toEqual(payload);
    expect(readdirSync(tmpDir)).toEqual(["session.bin.gz"]);
  });

  test("removes partial temporary output after a source read failure", async () => {
    const binPath = join(tmpDir, "session.bin");
    const payload = Buffer.alloc(1024 * 1024, 0x5a);
    writeFileSync(binPath, payload);
    sessionId = await insertSession(binPath, OLD_DATE);
    const createReadStream = fs.createReadStream;
    const readStream = spyOn(fs, "createReadStream").mockImplementation((path, options) => {
      const stream = createReadStream(path, options);
      if (path === binPath) {
        stream.once("data", () => stream.destroy(new Error("Injected source read failure")));
      }
      return stream;
    });
    try {
      await runCompressionNow();
    } finally {
      readStream.mockRestore();
    }

    expect(readFileSync(binPath)).toEqual(payload);
    expect(readdirSync(tmpDir)).toEqual(["session.bin"]);
    const row = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.rawFile).toBe(binPath);
  });

  test("keeps source and DB path when completed gzip cannot be published", async () => {
    const binPath = join(tmpDir, "session.bin");
    const payload = Buffer.from("preserve source after rename failure");
    writeFileSync(binPath, payload);
    mkdirSync(`${binPath}.gz`);
    sessionId = await insertSession(binPath, OLD_DATE);

    await runCompressionNow();

    expect(readFileSync(binPath)).toEqual(payload);
    expect(readdirSync(tmpDir).sort()).toEqual(["session.bin", "session.bin.gz"]);
    expect(readdirSync(`${binPath}.gz`)).toEqual([]);
    const row = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.rawFile).toBe(binPath);
  });

  test("does not delete source before the DB update succeeds", async () => {
    const binPath = join(tmpDir, "session.bin");
    const payload = Buffer.from("preserve source after DB failure");
    writeFileSync(binPath, payload);
    sessionId = await insertSession(binPath, OLD_DATE);
    const trigger = `compressor_update_failure_${sessionId}`;
    await client.execute(`
      CREATE TRIGGER ${trigger} BEFORE UPDATE OF raw_file ON sessions
      WHEN OLD.id = ${sessionId}
      BEGIN SELECT RAISE(ABORT, 'Injected session update failure'); END
    `);
    try {
      await runCompressionNow();
    } finally {
      await client.execute(`DROP TRIGGER ${trigger}`);
    }

    expect(readFileSync(binPath)).toEqual(payload);
    expect(gunzipSync(readFileSync(`${binPath}.gz`))).toEqual(payload);
    expect(readdirSync(tmpDir).sort()).toEqual(["session.bin", "session.bin.gz"]);
    const row = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.rawFile).toBe(binPath);
  });
});

describe("session capture cleanup", () => {
  let cleanupDir: string;

  beforeEach(() => {
    cleanupDir = join(
      resolveDataDir(),
      "sessions",
      `cleanup-test-${crypto.randomUUID()}`,
    );
    mkdirSync(cleanupDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(cleanupDir, { recursive: true, force: true });
  });

  test("stops orphan sweep when a recording starts during enumeration", async () => {
    const capturePath = join(cleanupDir, "active-session.bin");
    writeFileSync(capturePath, Buffer.alloc(32));
    let activityChecks = 0;

    const removed = await cleanupOrphanSessionFiles(() => {
      activityChecks++;
      return activityChecks > 1;
    });

    expect(removed).toBe(0);
    expect(activityChecks).toBeGreaterThan(1);
    expect(existsSync(capturePath)).toBe(true);

    await cleanupOrphanSessionFiles();
    expect(existsSync(capturePath)).toBe(false);
  });

  test("serializes capture maintenance with session transitions", async () => {
    let releaseFirst!: () => void;
    let secondStarted = false;
    const first = withSessionCaptureMaintenanceLock(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const second = withSessionCaptureMaintenanceLock(async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });
});
