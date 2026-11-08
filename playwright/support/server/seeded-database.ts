import Database from "libsql";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

import { DEFAULT_GAMES } from "@raceiq/tooling-data/data/seed-db-options";

type CaptureRow = {
  id: number;
  game_id: string;
  raw_file: string | null;
  capture_manifest_file: string | null;
  capture_archive_file: string | null;
};
type LiveCaptureRow = { session_id: number; source_path: string; archive_path: string };
type SeedAsset = { input: string; portable: string };

export function portableCapturePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[:\0]/.test(part)) ||
      !/^sessions\/(?:fm-2023|f1-2025|acc|ac-evo|iracing|lmu|ams2)\/(?:(?:(?:own|others)\/)?[^/]+\.bin(?:\.gz)?(?:\.opponents-removed\.capture-manifest\.json)?|capture-manifest\.json|(?:own|others)\/(?:[^/]+\/)+(?:capture-manifest\.json|manifest(?:\.live)?\.json|capture\.bin\.gz))$/.test(normalized)) {
    throw new Error(`Invalid seeded capture path: ${path}`);
  }
  return normalized;
}

function isOutside(root: string, path: string): boolean {
  const within = relative(root, path);
  return isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`);
}

function resolveContained(root: string, path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").includes("..") || normalized.includes("\0") ||
      (win32.isAbsolute(normalized) && !isAbsolute(normalized))) {
    throw new Error(`Capture outside seed directory: ${path}`);
  }
  const input = resolve(root, normalized);
  if (isOutside(root, input)) throw new Error(`Capture outside seed directory: ${path}`);
  let existing = input;
  while (true) {
    try { lstatSync(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = dirname(existing);
    }
  }
  if (isOutside(realpathSync(root), realpathSync(existing))) {
    throw new Error(`Capture outside seed directory: ${path}`);
  }
  return input;
}

function resolveSeedCapture(seedDirectory: string, rawFile: string): SeedAsset {
  const root = resolve(seedDirectory);
  const input = resolveContained(root, rawFile);
  const portable = portableCapturePath(relative(root, input));
  if (!existsSync(input) || !statSync(input).isFile() || !statSync(input).size) {
    throw new Error(`Missing seeded capture: ${input}`);
  }
  return { input, portable };
}

function collectSeedAssets(seedDirectory: string, captures: CaptureRow[], liveCaptures: LiveCaptureRow[]): Map<string, SeedAsset> {
  const root = resolve(seedDirectory);
  const assets = new Map<string, SeedAsset>();
  const manifests = new Set<string>();
  const addReference = (path: string): void => {
    const asset = resolveSeedCapture(root, path);
    assets.set(asset.portable, asset);
    if (asset.input.endsWith(".json")) manifests.add(asset.input);
  };
  for (const capture of captures) {
    if (!capture.raw_file && !capture.capture_manifest_file) throw new Error(`Seeded session ${capture.id} has no capture`);
    if (capture.raw_file) addReference(capture.raw_file);
    if (capture.capture_manifest_file) addReference(capture.capture_manifest_file);
    if (capture.capture_archive_file) addReference(capture.capture_archive_file);
  }
  for (const capture of liveCaptures) {
    addReference(capture.source_path);
    addReference(capture.archive_path);
  }
  for (const manifestPath of manifests) {
    // Keep the stored manifest unchanged: its asset paths remain relative to it.
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: number;
      gameId?: string;
      archiveFile?: unknown;
      chunks?: { path?: unknown; byteLength?: unknown }[];
      opponentRetention?: string;
      opponentCompanion?: { file?: unknown; byteLength?: unknown };
      cleanupPending?: unknown[];
    };
    const manifestDirectory = dirname(manifestPath);
    const addAsset = (path: unknown, optional = false, byteLength?: unknown): void => {
      if (typeof path !== "string" || !path || isAbsolute(path) || win32.isAbsolute(path) ||
          path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".." || /[:\0]/.test(part))) {
        throw new Error(`Invalid seeded manifest asset path: ${String(path)}`);
      }
      const input = resolveContained(manifestDirectory, path);
      if (optional && !existsSync(input)) return;
      if (!existsSync(input) || !statSync(input).isFile()) throw new Error(`Missing seeded capture asset: ${input}`);
      if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || Number(byteLength) < 0 || statSync(input).size !== byteLength)) {
        throw new Error(`Seeded capture asset byte length mismatch: ${input}`);
      }
      const portable = relative(root, input).replaceAll("\\", "/");
      assets.set(portable, { input, portable });
    };
    if (manifest.version === 3 && Array.isArray(manifest.chunks)) {
      for (const chunk of manifest.chunks) {
        if (typeof chunk.path !== "string" || !/\.bin(?:\.gz)?$/.test(chunk.path)) {
          throw new Error(`Invalid seeded manifest chunk: ${manifestPath}`);
        }
        addAsset(chunk.path, false, chunk.byteLength);
      }
      if (manifest.opponentCompanion) {
        if (typeof manifest.opponentCompanion.file !== "string" || manifest.opponentCompanion.file.includes("/")) {
          throw new Error(`Invalid seeded opponent companion: ${manifestPath}`);
        }
        const optional = manifest.opponentRetention === "removed" || manifest.opponentRetention === "not-recorded";
        addAsset(manifest.opponentCompanion.file, optional, manifest.opponentCompanion.byteLength);
      }
      if (manifest.cleanupPending !== undefined) {
        if (!Array.isArray(manifest.cleanupPending)) throw new Error(`Invalid seeded capture manifest: ${manifestPath}`);
        for (const path of manifest.cleanupPending) addAsset(path, true);
      }
    } else if ((manifest.version === 4 || manifest.version === 5) && manifest.archiveFile === "capture.bin.gz") {
      addAsset(manifest.archiveFile);
    } else {
      throw new Error(`Invalid seeded capture manifest: ${manifestPath}`);
    }
    if (captures.some((capture) =>
      [capture.raw_file, capture.capture_manifest_file].some((path) => path && resolveContained(root, path) === manifestPath) &&
      capture.game_id !== manifest.gameId)) {
      throw new Error(`Seeded capture manifest game mismatch: ${manifestPath}`);
    }
  }
  return assets;
}

function readLiveCaptures(database: InstanceType<typeof Database>): LiveCaptureRow[] {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_captures'").get()) return [];
  return database.prepare("SELECT session_id, source_path, archive_path FROM live_captures").all() as LiveCaptureRow[];
}

function rewriteCapturePaths(database: InstanceType<typeof Database>, captures: CaptureRow[], liveCaptures: LiveCaptureRow[], root: string, targetDirectory?: string): void {
  const rebase = (path: string | null): string | null => {
    if (path == null) return null;
    const asset = resolveSeedCapture(root, path);
    return targetDirectory ? resolve(targetDirectory, asset.portable) : asset.portable;
  };
  const update = database.prepare("UPDATE sessions SET raw_file = ?, capture_manifest_file = ?, capture_archive_file = ? WHERE id = ?");
  const updateLive = liveCaptures.length
    ? database.prepare("UPDATE live_captures SET source_path = ?, archive_path = ? WHERE session_id = ?")
    : null;
  database.transaction(() => {
    for (const capture of captures) {
      update.run(rebase(capture.raw_file), rebase(capture.capture_manifest_file), rebase(capture.capture_archive_file), capture.id);
    }
    for (const capture of liveCaptures) {
      updateLive!.run(rebase(capture.source_path), rebase(capture.archive_path), capture.session_id);
    }
  })();
}


export function checkSeededDatabase(database: InstanceType<typeof Database>): CaptureRow[] {
  const integrity = database.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Seeded database integrity check failed");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length) {
    throw new Error("Seeded database foreign key check failed");
  }
  for (const game of DEFAULT_GAMES) {
    const row = database.prepare(`
      SELECT COUNT(*) AS count FROM laps l JOIN sessions s ON s.id = l.session_id
      WHERE s.game_id = ? AND l.raw_frame_count > 0 AND (s.raw_file IS NOT NULL OR s.capture_manifest_file IS NOT NULL)
    `).get(game) as { count: number } | undefined;
    if (!row?.count) throw new Error(`Seeded database has no replayable laps for ${game}`);
  }
  return database.prepare("SELECT id, game_id, raw_file, capture_manifest_file, capture_archive_file FROM sessions").all() as CaptureRow[];
}

export function restoreSeededDatabase(repoDir: string, dataDir: string, source: string): void {
  const sourceDatabase = resolve(repoDir, source);
  const targetDatabase = resolve(dataDir, "app.db");
  if (sourceDatabase === targetDatabase) throw new Error("Seed artifact must be separate from runtime database");
  const sourceChatDatabase = resolve(dirname(sourceDatabase), "chat-memory.db");
  if (!existsSync(sourceChatDatabase) || !statSync(sourceChatDatabase).size) throw new Error(`Missing required seeded chat-memory database: ${sourceChatDatabase}`);
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(sourceDatabase, targetDatabase);
  const targetChatDatabase = resolve(dataDir, "chat-memory.db");
  mkdirSync(dirname(targetChatDatabase), { recursive: true });
  copyFileSync(sourceChatDatabase, targetChatDatabase);
  const database = new Database(targetDatabase);
  try {
    const captures = checkSeededDatabase(database);
    const liveCaptures = readLiveCaptures(database);
    const sourceDirectory = dirname(sourceDatabase);
    const assets = collectSeedAssets(sourceDirectory, captures, liveCaptures);
    for (const asset of assets.values()) {
      const output = resolveContained(resolve(dataDir), asset.portable);
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(asset.input, output);
    }
    rewriteCapturePaths(database, captures, liveCaptures, sourceDirectory, dataDir);
    console.log(`[E2E Seed] Restored database, chat memory, and ${captures.length} session references`);
  } finally {
    database.close();
  }
}

export function normalizeSeededCapturePaths(database: InstanceType<typeof Database>, dataDir: string): CaptureRow[] {
  const captures = checkSeededDatabase(database);
  const liveCaptures = readLiveCaptures(database);
  const seedDirectory = resolve(dataDir);
  collectSeedAssets(seedDirectory, captures, liveCaptures);
  rewriteCapturePaths(database, captures, liveCaptures, seedDirectory);
  return captures;
}
