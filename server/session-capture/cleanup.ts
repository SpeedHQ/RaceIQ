import { resolveRecordingDirectory, resolveRecordingGameDirectory } from "../runtime/config/recording-directory";
/**
 * Session file cleanup for startup and scheduled maintenance.
 *
 * Removes tiny `.bin` captures (at most the 12-byte metadata header) and
 * `.bin`, `.bin.gz`, and `.motec.zip` captures not referenced by `sessions.rawFile`.
 */
import { readdir, lstat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { sql } from "drizzle-orm";
import { META_FRAME_BYTES } from "@raceiq/capture-formats/session/framing";

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
  const sessionsDir = resolveRecordingDirectory();
  const captureFiles: string[] = [];
  const roots = [sessionsDir, resolveRecordingGameDirectory("", "mine"), resolveRecordingGameDirectory("", "others")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let games;
    try {
      if (root !== sessionsDir && !(await lstat(root)).isDirectory()) continue;
      games = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const game of games) {
      if (!game.isDirectory() || (root === sessionsDir && (game.name === "own" || game.name === "others"))) continue;
      const dirPath = join(root, game.name);
      let files;
      try {
        files = await readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.isFile() && (file.name.endsWith(".bin") || file.name.endsWith(".bin.gz") || file.name.endsWith(".motec.zip"))) {
          captureFiles.push(join(dirPath, file.name));
        }
      }
    }
  }
  return captureFiles;
}

export async function cleanupOrphanSessionFiles(
  sessionActive: () => boolean = () => false,
): Promise<number> {
  return withSessionCaptureMaintenanceLock(async () => {
    if (sessionActive()) {
      console.log("[Cleanup] Session active — skipping orphan sweep");
      return 0;
    }
    const sessionsDir = resolveRecordingDirectory();
    if (!existsSync(sessionsDir)) return 0;

    const referenced = await loadReferencedRawFiles();
    const captureFiles = await listSessionCaptureFiles();
    let removed = 0;
    for (const filePath of captureFiles) {
      if (sessionActive()) break;
      try {
        const info = await lstat(filePath);
        if (!info.isFile()) continue;
        const isTiny = filePath.endsWith(".bin") && info.size <= TINY_ORPHAN_THRESHOLD_BYTES;
        if (!isTiny && referenced.has(filePath)) continue;
        await unlink(filePath);
        removed++;
      } catch {
        // Skip unreadable / concurrently-removed entries
      }
    }
    return removed;
  });
}
