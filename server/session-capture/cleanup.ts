import { resolveRecordingDirectory } from "../runtime/config/recording-directory";
/**
 * Session file cleanup for startup and scheduled maintenance.
 *
 * Removes tiny `.bin` captures (at most the 12-byte metadata header) and
 * `.bin`, `.bin.gz`, and `.motec.zip` captures not referenced by `sessions.rawFile`.
 */
import { readdir, lstat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { db } from "../db/index";
import { sessions, sessionCaptureSplitJobs, laps } from "../db/schema";
import { sql } from "drizzle-orm";
import { loadCaptureManifest } from "./source-loader";
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
  const sessionsDir = resolveRecordingDirectory();
  const captureFiles: string[] = [];
  let games;
  try {
    games = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return captureFiles;
  }
  for (const game of games) {
    if (!game.isDirectory() || game.name === "own" || game.name === "others") continue;
    const gamePath = join(sessionsDir, game.name);
    let entries;
    try {
      entries = await readdir(gamePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith(".bin") || entry.name.endsWith(".bin.gz") || entry.name.endsWith(".motec.zip"))) {
        captureFiles.push(join(gamePath, entry.name));
      } else if (entry.isDirectory() && (entry.name === "own" || entry.name === "others")) {
        const ownershipPath = join(gamePath, entry.name);
        let captures;
        try {
          captures = await readdir(ownershipPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of captures) {
          if (file.isFile() && (file.name.endsWith(".bin") || file.name.endsWith(".bin.gz") || file.name.endsWith(".motec.zip"))) {
            captureFiles.push(join(ownershipPath, file.name));
          }
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
    // Migration imports the live pipeline, which also imports this maintenance lock.
    const { hasPendingLayoutMigration } = await import("./layout-migration");
    if (await hasPendingLayoutMigration()) {
      console.log("[Cleanup] Layout migration pending — skipping orphan sweep");
      return 0;
    }
    const sessionsDir = resolveRecordingDirectory();
    if (!existsSync(sessionsDir)) return 0;

    const referenced = await loadReferencedCapturePaths();
    const captureFiles = await listSessionCaptureFiles();
    let removed = 0;
    for (const filePath of captureFiles) {
      if (sessionActive()) break;
      try {
        const info = await lstat(filePath);
        if (!info.isFile()) continue;
        const isTiny = filePath.endsWith(".bin") && info.size <= 12;
        if (!isTiny && referenced.has(resolve(filePath))) continue;
        await unlink(filePath);
        removed++;
      } catch {
        // Skip unreadable / concurrently-removed entries
      }
    }
    return removed;
  });
}
