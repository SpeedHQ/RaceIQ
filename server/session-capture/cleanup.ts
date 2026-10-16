import { resolveRecordingDirectory } from "../runtime/config/recording-directory";
/**
 * Session file cleanup for startup and scheduled maintenance.
 *
 * Removes unreferenced recording files and controlled legacy/indexed bundle artifacts.
 * Protects published references, shared sources, and active split attempts.
 */
import { readdir, lstat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { db } from "../db/index";
import { sessions, sessionCaptureSplitJobs, liveCaptures } from "../db/schema";
import { clearCaptureManifestCache, clearSessionCaptureCache, loadCaptureManifest } from "./source-loader";
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
  const [sessionRows, jobRows, liveRows] = await Promise.all([
    db.select({ rawFile: sessions.rawFile, archiveFile: sessions.captureArchiveFile, manifestFile: sessions.captureManifestFile }).from(sessions).all(),
    db.select({ sourcePath: sessionCaptureSplitJobs.sourcePath, stagingPath: sessionCaptureSplitJobs.stagingPath })
      .from(sessionCaptureSplitJobs).all(),
    db.select({ sourcePath: liveCaptures.sourcePath, archivePath: liveCaptures.archivePath, status: liveCaptures.status, committedArchiveLength: liveCaptures.committedArchiveLength })
      .from(liveCaptures).all(),
  ]);
  const referenced = new Set<string>();
  for (const row of sessionRows) {
    if (row.rawFile) referenced.add(resolve(row.rawFile));
    if (row.archiveFile) referenced.add(resolve(row.archiveFile));
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
      if ("archiveFile" in manifest) referenced.add(resolve(dirname(row.manifestFile), manifest.archiveFile));
      else for (const chunk of manifest.chunks) referenced.add(resolve(dirname(row.manifestFile), chunk.path));
    } catch {
      // Preserve unknown members of a broken published manifest for recovery.
      referenced.add(resolve(dirname(row.manifestFile)));
    }
  }
  for (const row of liveRows) {
    if (row.status === "sealed" || (row.status === "failed" && row.committedArchiveLength === 0)) continue;
    const source = resolve(row.sourcePath);
    const archive = resolve(row.archivePath);
    referenced.add(source);
    referenced.add(archive);
    referenced.add(dirname(source));
    referenced.add(dirname(archive));
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

async function listBundleFiles(): Promise<string[]> {
  const root = resolveRecordingDirectory();
  const files: string[] = [];
  const games = await readdir(root, { withFileTypes: true }).catch(() => []);
  const attemptName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[1-9][0-9]*-[0-9a-f]{64}(?:\.staging)?$/i;
  for (const game of games) {
    if (!game.isDirectory()) continue;
    const gamePath = join(root, game.name);
    const gameEntries = await readdir(gamePath, { withFileTypes: true }).catch(() => []);
    const locations = [gamePath, ...gameEntries
      .filter((entry) => entry.isDirectory() && (entry.name === "own" || entry.name === "others"))
      .map((entry) => join(gamePath, entry.name))];
    for (const location of locations) {
      const entries = location === gamePath ? gameEntries : await readdir(location, { withFileTypes: true }).catch(() => []);
      for (const session of entries) {
        if (!session.isDirectory() || !/^session-[0-9]+$/.test(session.name)) continue;
        const sessionPath = join(location, session.name);
        for (const attempt of await readdir(sessionPath, { withFileTypes: true }).catch(() => [])) {
          if (!attempt.isDirectory() || !attemptName.test(attempt.name)) continue;
          const attemptPath = join(sessionPath, attempt.name);
          for (const file of await readdir(attemptPath, { withFileTypes: true }).catch(() => [])) {
            if (file.isFile() && (file.name === "manifest.json" || file.name === "capture.bin.gz" ||
                /^[0-9]{6,}-(?:lap-[0-9]+|aux)\.bin(?:\.gz)?$/.test(file.name))) {
              files.push(join(attemptPath, file.name));
            }
          }
        }
      }
    }
  }
  return files;
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
    const captureFiles = [...await listSessionCaptureFiles(), ...await listBundleFiles()];
    let removed = 0;
    for (const filePath of captureFiles) {
      if (sessionActive()) break;
      try {
        const info = await lstat(filePath);
        if (!info.isFile()) continue;
        if (referenced.has(resolve(filePath)) || referenced.has(resolve(dirname(filePath)))) continue;
        await unlink(filePath);
        clearSessionCaptureCache(filePath);
        removed++;
      } catch {
        // Skip unreadable / concurrently-removed entries
      }
    }
    if (removed > 0) clearCaptureManifestCache();
    return removed;
  });
}
