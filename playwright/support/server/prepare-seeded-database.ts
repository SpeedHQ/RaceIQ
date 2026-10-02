import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resetTestDatabase } from "./reset-test-database";
import { seedScreenshotData } from "./seed-screenshot-data";
import { normalizeSeededCapturePaths, SEEDED_GAMES } from "./seeded-database";
import { iterateSessionCaptureRecordsFromSource } from "../../../server/session-capture/source-loader";
import type { GameId } from "../../../shared/games/ids";

const repoDir = resolve(import.meta.dir, "../../..");
if (!process.env.DATA_DIR) throw new Error("DATA_DIR is required for seed artifact preparation");
const dataDir = resolve(process.env.DATA_DIR);
resetTestDatabase(dataDir);
mkdirSync(dataDir, { recursive: true });
process.env.PW_SEED_SCREENSHOTS = "1";
process.env.PW_SEED_GAMES = SEEDED_GAMES.join(",");
delete process.env.PW_SEEDED_DATABASE;
seedScreenshotData(repoDir, dataDir);

const database = new Database(resolve(dataDir, "app.db"));
try {
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
  console.log(`[E2E Seed] Checked integrity, foreign keys, ${SEEDED_GAMES.length} games and ${captures.length} capture references`);
} finally {
  database.close();
}
