/**
 * Background session compressor.
 *
 * Runs every 5 minutes. While no session is actively recording, finds session
 * .bin files older than 24 hours and gzips them in-place, updating the DB path
 * to .bin.gz. Skips if a session is active to avoid competing with live writes.
 */
import { unlinkSync, existsSync } from "fs";
import { getUncompressedSessions, updateSessionRawFile } from "../db/session-queries";
import { isSessionActive } from "../telemetry/live-pipeline";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { gzipBuffer } from "./framing";
import {
  cleanupOrphanSessionFiles,
  listSessionCaptureFiles,
} from "./cleanup";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;

interface CompressedFile {
  gzPath: string;
  sizeSummary: string;
}

async function writeCompressedFile(binPath: string): Promise<CompressedFile> {
  const gzPath = `${binPath}.gz`;
  const source = Buffer.from(await Bun.file(binPath).arrayBuffer());
  const compressed = await gzipBuffer(source);
  await Bun.write(gzPath, compressed);
  return {
    gzPath,
    sizeSummary: `${(source.byteLength / 1024).toFixed(0)}KB → ${(compressed.byteLength / 1024).toFixed(0)}KB`,
  };
}

async function compressSession(id: number, binPath: string): Promise<void> {
  const compressedFile = await writeCompressedFile(binPath);

  // Fetch current lapDetectorVersion to preserve it in the update
  const row = await db
    .select({ lapDetectorVersion: sessions.lapDetectorVersion })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();

  await updateSessionRawFile(
    id,
    compressedFile.gzPath,
    row?.lapDetectorVersion ?? "",
  );
  unlinkSync(binPath);
  console.log(
    `[Compressor] ${binPath} → ${compressedFile.gzPath} (${compressedFile.sizeSummary})`,
  );
}

/**
 * Compress a .bin file on disk that has no matching DB session row (orphan).
 * Writes .bin.gz, removes .bin. No DB update since there's nothing to point.
 */
async function compressOrphanFile(binPath: string): Promise<void> {
  const compressedFile = await writeCompressedFile(binPath);
  unlinkSync(binPath);
  console.log(
    `[Compressor] (orphan) ${binPath} → ${compressedFile.gzPath} (${compressedFile.sizeSummary})`,
  );
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
    ? (await listSessionCaptureFiles()).filter(
        (path) => path.endsWith(".bin") && !dbPaths.has(path),
      )
    : [];

  const total = candidates.length + orphanPaths.length;
  if (total === 0) {
    console.debug("[Compressor] No sessions to compress");
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
  const removed = await cleanupOrphanSessionFiles(isSessionActive());
  console.debug(
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
