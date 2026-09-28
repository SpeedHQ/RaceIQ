/**
 * Background session compressor.
 *
 * Runs every 5 minutes. While no session is actively recording, finds session
 * .bin files older than 24 hours and gzips them in-place, updating the DB path
 * to .bin.gz. Skips if a session is active to avoid competing with live writes.
 */
import { createReadStream, createWriteStream, unlinkSync, existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { getUncompressedSessions } from "../db/session-queries";
import { isSessionActive } from "../telemetry/live-pipeline";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { eq } from "drizzle-orm";
import { cleanupOrphanSessionFiles, listSessionCaptureFiles, withSessionCaptureMaintenanceLock } from "./cleanup";
import { cleanupExpiredStagedMotec } from "../motec/import-staging";
import { loadSettings } from "../runtime/config/settings";
import { executeSessionCleanup, SessionCleanupBusyError } from "./session-cleanup";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;

interface CompressedFile {
  gzPath: string;
  sizeSummary: string;
}

async function writeCompressedFile(binPath: string): Promise<CompressedFile> {
  const gzPath = `${binPath}.gz`;
  if (existsSync(gzPath)) {
    throw new Error(`Compressed target already exists: ${gzPath}`);
  }
  const tempPath = `${gzPath}.${crypto.randomUUID()}.tmp`;
  const source = createReadStream(binPath);
  const destination = createWriteStream(tempPath, { flags: "wx" });
  try {
    await pipeline(source, createGzip(), destination);
    await rename(tempPath, gzPath);
    return {
      gzPath,
      sizeSummary: `${(source.bytesRead / 1024).toFixed(0)}KB → ${(destination.bytesWritten / 1024).toFixed(0)}KB`,
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch((cleanupError) => {
      console.error(`[Compressor] Failed to remove temporary file ${tempPath}:`, cleanupError);
    });
    throw error;
  }
}

async function compressSessionGroup(ids: number[], binPath: string): Promise<void> {
  const compressedFile = await writeCompressedFile(binPath);
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ rawFile: compressedFile.gzPath })
        .where(eq(sessions.rawFile, binPath))
        .run();
    });
  } catch (error) {
    await rm(compressedFile.gzPath, { force: true }).catch((cleanupError) => {
      console.error(`[Compressor] Failed to remove uncommitted target ${compressedFile.gzPath}:`, cleanupError);
    });
    throw error;
  }

  unlinkSync(binPath);
  console.log(`[Compressor] ${ids.length} session(s): ${binPath} → ${compressedFile.gzPath} (${compressedFile.sizeSummary})`);
}

/**
 * Compress a .bin file on disk that has no matching DB session row (orphan).
 * Writes .bin.gz, removes .bin. No DB update since there's nothing to point.
 */
async function compressOrphanFile(binPath: string): Promise<void> {
  const compressedFile = await writeCompressedFile(binPath);
  unlinkSync(binPath);
  console.log(`[Compressor] (orphan) ${binPath} → ${compressedFile.gzPath} (${compressedFile.sizeSummary})`);
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
  await withSessionCaptureMaintenanceLock(async () => {
    // Recording may have started while this pass waited for maintenance.
    if (isSessionActive()) return;

    const ageMs = userTriggered ? 0 : ONE_DAY_MS;
    const candidates = await getUncompressedSessions(ageMs);
    const groupedCandidates = new Map<string, number[]>();
    for (const { id, rawFile } of candidates) {
      const ids = groupedCandidates.get(rawFile) ?? [];
      ids.push(id);
      groupedCandidates.set(rawFile, ids);
    }
    const dbPaths = new Set(groupedCandidates.keys());

    // User-triggered: also sweep .bin files that live on disk without a DB row.
    // Background (age-gated) runs stay DB-driven so we don't compress brand-new
    // files still being written by a just-finished session.
    const orphanPaths = userTriggered
      ? (await listSessionCaptureFiles()).filter((path) => path.endsWith(".bin") && !dbPaths.has(path))
      : [];

    const total = groupedCandidates.size + orphanPaths.length;
    if (total === 0) {
      console.debug("[Compressor] No sessions to compress");
      return;
    }

    console.log(`[Compressor] Compressing ${candidates.length} session(s) across ${groupedCandidates.size} capture(s), ${orphanPaths.length} orphan file(s)…`);
    for (const [rawFile, ids] of groupedCandidates) {
      if (isSessionActive()) break;
      try {
        const file = Bun.file(rawFile);
        if (!(await file.exists())) continue;
        await compressSessionGroup(ids, rawFile);
      } catch (err) {
        console.error(`[Compressor] Failed to compress capture ${rawFile}:`, err);
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
  });
}

let _interval: ReturnType<typeof setInterval> | null = null;

async function runMaintenance(): Promise<void> {
  await runSessionCaptureMaintenanceNow();
}

export async function runSessionCaptureMaintenanceNow(): Promise<void> {
  await runCompression();
  const settings = loadSettings();
  if (settings.sessionCleanupEnabled && !isSessionActive()) {
    try {
      const result = await executeSessionCleanup({ mode: "older-than", olderThanDays: settings.sessionCleanupAgeDays });
      if (result.failed.length > 0) {
        console.warn(`[Cleanup] Failed to remove ${result.failed.length} capture group(s)`);
      }
    } catch (error) {
      if (!(error instanceof SessionCleanupBusyError)) console.error("[Cleanup] Automatic capture cleanup failed:", error);
    }
  }
  const [orphanCount, stagedMotecCount] = await Promise.all([cleanupOrphanSessionFiles(isSessionActive), cleanupExpiredStagedMotec()]);
  console.debug(orphanCount > 0 ? `[Cleanup] Removed ${orphanCount} orphan session file(s)` : "[Cleanup] No orphan session files found");
  if (stagedMotecCount > 0) {
    console.debug(`[Cleanup] Removed ${stagedMotecCount} expired MoTeC staging director${stagedMotecCount === 1 ? "y" : "ies"}`);
  }
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
