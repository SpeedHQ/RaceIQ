/**
 * Session file cleanup for startup and scheduled maintenance.
 *
 * Removes tiny `.bin` captures (at most the 12-byte metadata header) and
 * `.bin`, `.bin.gz`, and `.motec.zip` captures not referenced by `sessions.rawFile`.
 */
import { readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { db } from "../db/index";
import { sessions, sessionCaptureSplitJobs, laps } from "../db/schema";
import { sql } from "drizzle-orm";
import { loadCaptureManifest } from "./source-loader";
import { resolveDataDir } from "../runtime/config/data-dir";
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

export async function loadReferencedCapturePaths(): Promise<Set<string>> {
  const [sessionRows, jobRows, lapRows] = await Promise.all([
    db.select({ rawFile: sessions.rawFile, manifestFile: sessions.captureManifestFile }).from(sessions).all(),
    db.select({ sourcePath: sessionCaptureSplitJobs.sourcePath, stagingPath: sessionCaptureSplitJobs.stagingPath })
      .from(sessionCaptureSplitJobs).all(),
    db.select({ manifestFile: sessions.captureManifestFile })
      .from(laps).innerJoin(sessions, sql`${laps.sessionId} = ${sessions.id}`)
      .where(sql`${laps.captureChunkId} IS NOT NULL`).all(),
  ]);
  const referenced = new Set<string>();
  for (const row of sessionRows) {
    if (row.rawFile) referenced.add(resolve(row.rawFile));
    if (row.manifestFile) referenced.add(resolve(row.manifestFile));
  }
  for (const row of jobRows) {
    referenced.add(resolve(row.sourcePath));
    if (row.stagingPath) referenced.add(resolve(row.stagingPath));
  }
  for (const row of sessionRows) {
    if (!row.manifestFile) continue;
    try {
      const manifest = await loadCaptureManifest(row.manifestFile);
      for (const chunk of manifest.chunks) referenced.add(resolve(dirname(row.manifestFile), chunk.path));
    } catch {
      // Broken manifests still protect the manifest itself, not unknown members.
    }
  }
  for (const row of lapRows) if (row.manifestFile) referenced.add(resolve(row.manifestFile));
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
  async function visit(dirPath: string): Promise<void> {
    for (const entry of await readdir(dirPath, { withFileTypes: true })) {
      const path = join(dirPath, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (entry.name.endsWith(".bin") || entry.name.endsWith(".bin.gz") || entry.name.endsWith(".motec.zip"))) captureFiles.push(path);
    }
  }
  await visit(sessionsDir);
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
    const sessionsDir = resolve(resolveDataDir(), "sessions");
    if (!existsSync(sessionsDir)) return 0;

    const referenced = await loadReferencedCapturePaths();
    const captureFiles = await listSessionCaptureFiles();
    let removed = 0;
    for (const filePath of captureFiles) {
      if (sessionActive()) break;
      try {
        if (referenced.has(resolve(filePath))) continue;
        await unlink(filePath);
        removed++;
      } catch {
        // Skip unreadable / concurrently-removed entries
      }
    }
    return removed;
  });
}
