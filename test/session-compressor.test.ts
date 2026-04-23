/**
 * Tests for session-compressor: compression of old .bin files,
 * skipping of new files, and graceful handling of missing files.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { db } from "../server/db/index";
import { sessions } from "../server/db/schema";
import { eq } from "drizzle-orm";
import { runCompressionNow } from "../server/session-compressor";

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

    const gzPath = binPath + ".gz";
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
    expect(existsSync(binPath + ".gz")).toBe(false);
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

  test("compressed output is valid gzip", async () => {
    const binPath = join(tmpDir, "session.bin");
    writeFileSync(binPath, Buffer.from("test payload for gzip check"));

    sessionId = await insertSession(binPath, OLD_DATE);
    await runCompressionNow();

    const gzPath = binPath + ".gz";
    const buf = Buffer.from(await Bun.file(gzPath).arrayBuffer());
    // gzip magic bytes: 0x1f 0x8b
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });
});
