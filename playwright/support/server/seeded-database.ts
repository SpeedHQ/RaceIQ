import Database from "libsql";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { DEFAULT_GAMES } from "@raceiq/tooling-data/data/seed-db-options";

type CaptureRow = { id: number; game_id: string; raw_file: string | null; capture_manifest_file: string | null };

export function portableCapturePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const capture = /^sessions\/(?:fm-2023|f1-2025|acc|ac-evo|iracing|lmu|ams2)\/(?:(?:own|others)\/)?[^/]+\.bin(?:\.gz)?$/;
  const lmuManifest = /^sessions\/lmu\/own\/(?!\.{1,2}\/)[^/]+\/capture-manifest\.json$/;
  if (!capture.test(normalized) && !lmuManifest.test(normalized)) {
    throw new Error(`Invalid seeded capture path: ${path}`);
  }
  return normalized;
}

function copyCaptureBundle(source: string, destination: string): void {
  const entries = readdirSync(source, { withFileTypes: true });
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const input = resolve(source, entry.name);
    const output = resolve(destination, entry.name);
    const info = lstatSync(input);
    if (info.isSymbolicLink()) throw new Error(`Symlink in seeded capture bundle: ${input}`);
    if (info.isDirectory()) copyCaptureBundle(input, output);
    else if (info.isFile() && info.size > 0) copyFileSync(input, output);
    else throw new Error(`Invalid seeded capture bundle entry: ${input}`);
  }
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
      WHERE s.game_id = ? AND l.raw_frame_count > 0 AND s.raw_file IS NOT NULL
    `).get(game) as { count: number } | undefined;
    if (!row?.count) throw new Error(`Seeded database has no replayable laps for ${game}`);
  }
  return database.prepare("SELECT id, game_id, raw_file, capture_manifest_file FROM sessions").all() as CaptureRow[];
}

export function restoreSeededDatabase(repoDir: string, dataDir: string, source: string): void {
  const sourceDatabase = resolve(repoDir, source);
  const targetDatabase = resolve(dataDir, "app.db");
  if (sourceDatabase === targetDatabase) throw new Error("Seed artifact must be separate from runtime database");
  const sourceChatDatabase = resolve(dirname(sourceDatabase), "chat-memory.db");
  if (!existsSync(sourceChatDatabase) || !statSync(sourceChatDatabase).size) throw new Error(`Missing required seeded chat-memory database: ${sourceChatDatabase}`);
  copyFileSync(sourceDatabase, targetDatabase);
  const targetChatDatabase = resolve(dataDir, "chat-memory.db");
  mkdirSync(dirname(targetChatDatabase), { recursive: true });
  copyFileSync(sourceChatDatabase, targetChatDatabase);
  const database = new Database(targetDatabase);
  try {
    const captures = checkSeededDatabase(database);
    const update = database.prepare("UPDATE sessions SET raw_file = ?, capture_manifest_file = ? WHERE id = ?");
    const copied = new Set<string>();
    database.transaction(() => {
      for (const capture of captures) {
        if (!capture.raw_file) throw new Error(`Seeded session ${capture.id} has no capture`);
        const path = portableCapturePath(capture.raw_file);
        const input = resolve(dirname(sourceDatabase), path);
        const bundle = path.endsWith("/capture-manifest.json");
        if (bundle) {
          const bundleInput = dirname(input);
          const manifestInfo = lstatSync(input);
          if (!manifestInfo.isFile() || manifestInfo.size === 0) throw new Error(`Missing seeded capture: ${input}`);
          const output = resolve(dataDir, path);
          const bundleOutput = dirname(output);
          if (!copied.has(bundleOutput)) {
            copyCaptureBundle(bundleInput, bundleOutput);
            copied.add(bundleOutput);
          }
          const manifest = capture.capture_manifest_file
            ? resolve(dataDir, portableCapturePath(capture.capture_manifest_file))
            : null;
          update.run(output, manifest, capture.id);
          continue;
        }
        if (!existsSync(input) || !statSync(input).size) throw new Error(`Missing seeded capture: ${input}`);
        const output = resolve(dataDir, path);
        if (!copied.has(output)) {
          mkdirSync(dirname(output), { recursive: true });
          copyFileSync(input, output);
          copied.add(output);
        }
        update.run(output, capture.capture_manifest_file, capture.id);
      }
    })();
    console.log(`[E2E Seed] Restored database, chat memory, and ${captures.length} session references`);
  } finally {
    database.close();
  }
}

export function normalizeSeededCapturePaths(database: InstanceType<typeof Database>, dataDir: string): CaptureRow[] {
  const captures = checkSeededDatabase(database);
  const update = database.prepare("UPDATE sessions SET raw_file = ?, capture_manifest_file = ? WHERE id = ?");
  database.transaction(() => {
    for (const capture of captures) {
      if (!capture.raw_file) throw new Error(`Seeded session ${capture.id} has no capture`);
      const path = relative(dataDir, capture.raw_file);
      if (isAbsolute(path) || path.startsWith(`..${sep}`)) throw new Error(`Capture outside seed directory: ${capture.raw_file}`);
      const portable = portableCapturePath(path);
      if (!existsSync(capture.raw_file) || !statSync(capture.raw_file).size) throw new Error(`Missing seeded capture: ${capture.raw_file}`);
      let manifest: string | null = null;
      if (capture.capture_manifest_file !== null) {
        const manifestRelative = relative(dataDir, capture.capture_manifest_file);
        if (isAbsolute(manifestRelative) || manifestRelative.startsWith(`..${sep}`)) {
          throw new Error(`Capture manifest outside seed directory: ${capture.capture_manifest_file}`);
        }
        manifest = portableCapturePath(manifestRelative);
        if (!existsSync(capture.capture_manifest_file) || !statSync(capture.capture_manifest_file).size) {
          throw new Error(`Missing seeded capture manifest: ${capture.capture_manifest_file}`);
        }
      }
      update.run(portable, manifest, capture.id);
    }
  })();
  return captures;
}
