import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { DEFAULT_GAMES } from "../../../scripts/data/seed-db-options";

type CaptureRow = { id: number; game_id: string; raw_file: string | null };

export function portableCapturePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (!/^sessions\/(?:fm-2023|f1-2025|acc|ac-evo|iracing|lmu)\/[^/]+\.bin(?:\.gz)?$/.test(normalized)) {
    throw new Error(`Invalid seeded capture path: ${path}`);
  }
  return normalized;
}

export function checkSeededDatabase(database: Database): CaptureRow[] {
  const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("Seeded database integrity check failed");
  }
  if (database.query("PRAGMA foreign_key_check").all().length) {
    throw new Error("Seeded database foreign key check failed");
  }
  for (const game of DEFAULT_GAMES) {
    const row = database.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM laps l JOIN sessions s ON s.id = l.session_id
      WHERE s.game_id = ? AND l.raw_frame_count > 0 AND s.raw_file IS NOT NULL
    `).get(game);
    if (!row?.count) throw new Error(`Seeded database has no replayable laps for ${game}`);
  }
  return database.query<CaptureRow, []>("SELECT id, game_id, raw_file FROM sessions").all();
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
    const update = database.query("UPDATE sessions SET raw_file = ? WHERE id = ?");
    const copied = new Set<string>();
    database.transaction(() => {
      for (const capture of captures) {
        if (!capture.raw_file) throw new Error(`Seeded session ${capture.id} has no capture`);
        const path = portableCapturePath(capture.raw_file);
        const input = resolve(dirname(sourceDatabase), path);
        if (!existsSync(input) || !statSync(input).size) throw new Error(`Missing seeded capture: ${input}`);
        const output = resolve(dataDir, path);
        if (!copied.has(output)) {
          mkdirSync(dirname(output), { recursive: true });
          copyFileSync(input, output);
          copied.add(output);
        }
        update.run(output, capture.id);
      }
    })();
    console.log(`[E2E Seed] Restored database, chat memory, and ${captures.length} session references`);
  } finally {
    database.close();
  }
}

export function normalizeSeededCapturePaths(database: Database, dataDir: string): CaptureRow[] {
  const captures = checkSeededDatabase(database);
  const update = database.query("UPDATE sessions SET raw_file = ? WHERE id = ?");
  database.transaction(() => {
    for (const capture of captures) {
      if (!capture.raw_file) throw new Error(`Seeded session ${capture.id} has no capture`);
      const path = relative(dataDir, capture.raw_file);
      if (isAbsolute(path) || path.startsWith(`..${sep}`)) throw new Error(`Capture outside seed directory: ${capture.raw_file}`);
      const portable = portableCapturePath(path);
      if (!existsSync(capture.raw_file) || !statSync(capture.raw_file).size) throw new Error(`Missing seeded capture: ${capture.raw_file}`);
      update.run(portable, capture.id);
    }
  })();
  return captures;
}
