/**
 * Background session compressor.
 *
 * Runs every 5 minutes. While no session is actively recording, finds session
 * .bin files older than 24 hours and gzips them in-place, updating the DB path
 * to .bin.gz. Skips if a session is active to avoid competing with live writes.
 */
import { unlinkSync, existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import { resolve, join } from "path";
import { gzip } from "zlib";
import { promisify } from "util";

const gzipAsync = promisify(gzip);
import { getUncompressedSessions, updateSessionRawFile } from "./db/queries";
import { isSessionActive } from "./pipeline";
import { db } from "./db/index";
import { sessions } from "./db/schema";
import { eq } from "drizzle-orm";
import { resolveDataDir } from "./data-dir";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;

async function compressSession(id: number, binPath: string): Promise<void> {
  const gzPath = binPath + ".gz";
  const data = await Bun.file(binPath).arrayBuffer();
  const compressed = await gzipAsync(Buffer.from(data));
  await Bun.write(gzPath, compressed);

  // Fetch current lapDetectorVersion to preserve it in the update
  const row = await db
    .select({ lapDetectorVersion: sessions.lapDetectorVersion })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();

  await updateSessionRawFile(id, gzPath, row?.lapDetectorVersion ?? "");
  unlinkSync(binPath);
  console.log(`[Compressor] ${binPath} → ${gzPath} (${(data.byteLength / 1024).toFixed(0)}KB → ${(compressed.byteLength / 1024).toFixed(0)}KB)`);
}

/**
 * Compress a .bin file on disk that has no matching DB session row (orphan).
 * Writes .bin.gz, removes .bin. No DB update since there's nothing to point.
 */
async function compressOrphanFile(binPath: string): Promise<void> {
  const gzPath = binPath + ".gz";
  const data = await Bun.file(binPath).arrayBuffer();
  const compressed = await gzipAsync(Buffer.from(data));
  await Bun.write(gzPath, compressed);
  unlinkSync(binPath);
  console.log(`[Compressor] (orphan) ${binPath} → ${gzPath} (${(data.byteLength / 1024).toFixed(0)}KB → ${(compressed.byteLength / 1024).toFixed(0)}KB)`);
}

/**
 * Walk data/sessions/<gameId>/*.bin. Returns absolute paths of every
 * uncompressed recording file on disk, regardless of whether a DB row points
 * at it. User-triggered compression uses this so orphaned .bin files (tests,
 * failed past compressions, deleted sessions) still get swept up.
 */
async function findUncompressedFilesOnDisk(): Promise<string[]> {
  const sessionsDir = resolve(resolveDataDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const results: string[] = [];
  const gameDirs = await readdir(sessionsDir);
  for (const gameDir of gameDirs) {
    const dirPath = join(sessionsDir, gameDir);
    try {
      if (!(await stat(dirPath)).isDirectory()) continue;
    } catch { continue; }
    const files = await readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".bin")) continue;
      results.push(join(dirPath, file));
    }
  }
  return results;
}

/** Background-style compression: respects the 24-hour age filter. */
export async function runCompressionNow(): Promise<void> {
  return runCompression(false);
}

/** User-triggered compression: ignores the age filter, compresses all uncompressed sessions. */
export async function runUserCompressionNow(): Promise<void> {
  return runCompression(true);
}

async function runCompression(userTriggered = false): Promise<void> {
  if (isSessionActive()) return;

  const ageMs = userTriggered ? 0 : ONE_DAY_MS;
  const candidates = await getUncompressedSessions(ageMs);
  const dbPaths = new Set(candidates.map((c) => c.rawFile));

  // User-triggered: also sweep .bin files that live on disk without a DB row.
  // Background (age-gated) runs stay DB-driven so we don't compress brand-new
  // files still being written by a just-finished session.
  const orphanPaths = userTriggered
    ? (await findUncompressedFilesOnDisk()).filter((p) => !dbPaths.has(p))
    : [];

  const total = candidates.length + orphanPaths.length;
  if (total === 0) {
    console.log("[Compressor] No sessions to compress");
    return;
  }

  console.log(`[Compressor] Compressing ${candidates.length} session(s), ${orphanPaths.length} orphan file(s)…`);
  for (const { id, rawFile } of candidates) {
    if (isSessionActive()) break;
    try {
      const file = Bun.file(rawFile);
      if (!(await file.exists())) continue;
      await compressSession(id, rawFile);
    } catch (err) {
      console.error(`[Compressor] Failed to compress session ${id}:`, err);
    }
  }
  for (const path of orphanPaths) {
    if (isSessionActive()) break;
    try {
      if (!existsSync(path)) continue;
      await compressOrphanFile(path);
    } catch (err) {
      console.error(`[Compressor] Failed to compress orphan ${path}:`, err);
    }
  }
}

let _interval: ReturnType<typeof setInterval> | null = null;

async function runMaintenance(): Promise<void> {
  await runCompression();
  // Piggyback orphan sweep on the same interval. cleanupOrphanSessionFiles()
  // is a no-op during an active session, so it's safe to run here.
  const { cleanupOrphanSessionFiles } = await import("./session-cleanup");
  const removed = await cleanupOrphanSessionFiles();
  console.log(
    removed > 0
      ? `[Cleanup] Removed ${removed} orphan session file(s)`
      : "[Cleanup] No orphan session files found"
  );
}

export function startSessionCompressor(): void {
  if (_interval) return;
  // Run immediately on startup, then every 5 minutes
  void runMaintenance();
  _interval = setInterval(() => void runMaintenance(), INTERVAL_MS);
}

export function stopSessionCompressor(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
