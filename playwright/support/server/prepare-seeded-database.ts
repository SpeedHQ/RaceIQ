import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resetTestDatabase } from "./reset-test-database";
import { seedScreenshotData } from "./seed-screenshot-data";
import { normalizeSeededCapturePaths } from "./seeded-database";
import { iterateSessionCaptureRecordsFromSource } from "@raceiq/backend-core/session-capture/source-loader";
import type { GameId } from "@raceiq/shared/games/ids";
import { DEFAULT_GAMES } from "@raceiq/tooling-data/data/seed-db-options";

const repoDir = resolve(import.meta.dir, "../../..");
if (!process.env.DATA_DIR) throw new Error("DATA_DIR is required for seed artifact preparation");
const dataDir = resolve(process.env.DATA_DIR);
resetTestDatabase(dataDir);
mkdirSync(dataDir, { recursive: true });
process.env.PW_SEED_SCREENSHOTS = "1";
process.env.PW_SEED_GAMES = DEFAULT_GAMES.join(",");
delete process.env.PW_SEEDED_DATABASE;
seedScreenshotData(repoDir, dataDir);
const { chatThreadId, compareChatThreadId, getChatMemory } = await import("@raceiq/backend-core/ai/chat-agent");

const database = new Database(resolve(dataDir, "app.db"));
try {
  const chatSeed = database.query<{ id: number }, []>(`
    SELECT l.id FROM laps l JOIN sessions s ON s.id = l.session_id
    WHERE s.game_id = 'fm-2023' AND l.is_valid = 1 ORDER BY l.id
  `).all();
  if (chatSeed.length < 2 || !chatSeed.at(-1) || !chatSeed[0]) throw new Error("Seeded FM chat laps are missing");
  const memory = getChatMemory();
  for (const threadId of [
    chatThreadId(chatSeed[0].id),
    compareChatThreadId(chatSeed[0].id, chatSeed.at(-1)!.id),
  ]) {
    if (!await memory.getThreadById({ threadId })) throw new Error(`Missing seeded chat thread: ${threadId}`);
    const { messages } = await memory.recall({ threadId, perPage: false });
    if (!messages.some((message) => message.role === "user")) throw new Error(`Missing seeded chat history: ${threadId}`);
  }
  const chatDatabase = new Database(resolve(dataDir, "chat-memory.db"));
  try {
    if (chatDatabase.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
      throw new Error("Seeded chat-memory database integrity check failed");
    }
    if (chatDatabase.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy !== 0) {
      throw new Error("Seeded chat-memory WAL checkpoint failed");
    }
  } finally {
    chatDatabase.close();
  }
  // Verify generated captures before replacing producer-specific absolute paths.
  const captures = database.query<{ raw_file: string; game_id: string; car_ordinal: number; track_ordinal: number; source: string | null }, []>(
    "SELECT raw_file, game_id, car_ordinal, track_ordinal, source FROM sessions",
  ).all();
  for (const capture of captures) {
    let hasFrame = false;
    for await (const record of iterateSessionCaptureRecordsFromSource({
      rawFile: capture.raw_file, gameId: capture.game_id as GameId,
      carOrdinal: capture.car_ordinal, trackOrdinal: capture.track_ordinal, source: capture.source,
    }, { strict: true })) {
      if (record.kind === "frame") { hasFrame = true; break; }
    }
    if (!hasFrame) throw new Error(`Seeded capture has no telemetry: ${capture.raw_file}`);
  }
  normalizeSeededCapturePaths(database, dataDir);
  const checkpoint = database.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
  if (checkpoint?.busy !== 0) throw new Error("Seeded database WAL checkpoint failed");
  console.log(`[E2E Seed] Checked integrity, foreign keys, ${DEFAULT_GAMES.length} games and ${captures.length} capture references`);
} finally {
  database.close();
}
