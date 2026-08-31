/**
 * Session file cleanup for startup and scheduled maintenance.
 *
 * Removes tiny `.bin` captures (at most the 12-byte metadata header) and
 * `.bin`, `.bin.gz`, and `.motec.zip` captures not referenced by `sessions.rawFile`.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveDataDir } from "../runtime/config/data-dir";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { sql } from "drizzle-orm";
import { META_FRAME_BYTES } from "./framing";

const TINY_ORPHAN_THRESHOLD_BYTES = META_FRAME_BYTES;

let maintenanceQueue = Promise.resolve();

export function withSessionCaptureMaintenanceLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = maintenanceQueue;
  let release!: () => void;
  maintenanceQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(operation).finally(release);
}

async function loadReferencedRawFiles(): Promise<Set<string>> {
  const rows = await db
    .select({ rawFile: sessions.rawFile })
    .from(sessions)
    .where(sql`${sessions.rawFile} IS NOT NULL`)
    .all();
  const referenced = new Set<string>();
  for (const { rawFile } of rows) {
    if (rawFile != null) referenced.add(rawFile);
  }
  return referenced;
}

/**
 * Enumerate capture files in game subdirectories.
 * Shared with compression so both maintenance paths apply the same directory
 * and extension rules.
 */
export async function listSessionCaptureFiles(): Promise<string[]> {
  const sessionsDir = resolve(resolveDataDir(), "sessions");
  if (!existsSync(sessionsDir)) return [];

  const captureFiles: string[] = [];
  for (const gameDir of await readdir(sessionsDir)) {
    const dirPath = join(sessionsDir, gameDir);
    try {
      if (!(await stat(dirPath)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of await readdir(dirPath)) {
      if (file.endsWith(".bin") || file.endsWith(".bin.gz") || file.endsWith(".motec.zip")) {
        captureFiles.push(join(dirPath, file));
      }
    }
  }
  return captureFiles;
}

export async function cleanupOrphanSessionFiles(
  sessionActive: () => boolean = () => false,
): Promise<number> {
  if (sessionActive()) {
    console.log("[Cleanup] Session active — skipping orphan sweep");
    return 0;
  }
  const sessionsDir = resolve(resolveDataDir(), "sessions");
  if (!existsSync(sessionsDir)) return 0;

  const referenced = await loadReferencedRawFiles();
  const captureFiles = await listSessionCaptureFiles();
  let removed = 0;
  for (const filePath of captureFiles) {
    const deleted = await withSessionCaptureMaintenanceLock(async () => {
      if (sessionActive()) return false;
      try {
        const { size } = await stat(filePath);
        if (sessionActive()) return false;
        const isTiny =
          filePath.endsWith(".bin") &&
          size <= TINY_ORPHAN_THRESHOLD_BYTES;
        const isUntracked = !referenced.has(filePath);
        if (!isTiny && !isUntracked) return false;
        await unlink(filePath);
        return true;
      } catch {
        // Skip unreadable / concurrently-removed entries
        return false;
      }
    });
    if (deleted) removed++;
  }
  return removed;
}
