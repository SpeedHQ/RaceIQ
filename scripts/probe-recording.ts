/**
 * Usage: bun scripts/probe-recording.ts <gameId> [path]
 *
 * If path is omitted, uses the latest recording for that game:
 *   bun scripts/probe-recording.ts acc
 *   bun scripts/probe-recording.ts f1-2025 test/artifacts/laps/dump.bin
 */
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { parseDump } from "../test/helpers/parse-dump";
import type { GameId } from "../shared/types";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

const gameId = process.argv[2] as GameId;
if (!gameId) {
  console.error("Usage: bun scripts/probe-recording.ts <gameId> [path]");
  process.exit(1);
}

function latestForGame(gameId: string): string | null {
  if (gameId === "acc") {
    const dir = "test/artifacts/laps";
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".bin")).sort().reverse();
    return files.length > 0 ? join(dir, files[0]) : null;
  }
  const dir = "test/artifacts/laps";
  if (!existsSync(dir)) return null;
  const sessions = readdirSync(dir).sort().reverse();
  for (const session of sessions) {
    const p = join(dir, session, "dump.bin");
    if (existsSync(p)) return p;
  }
  return null;
}

const path = process.argv[3] ?? latestForGame(gameId);
if (!path || !existsSync(path)) {
  console.error(`No recording found for ${gameId}. Run: bun run dev:record:${gameId === "fm-2023" ? "fm" : gameId}`);
  process.exit(1);
}

console.error(`Probing: ${path}`);
initGameAdapters();
initServerGameAdapters();
const laps = await parseDump(gameId, path);
console.log(JSON.stringify(laps, null, 2));
