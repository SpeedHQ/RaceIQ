import { accRecordingSupport } from "@raceiq/game-acc/test-support/recordings";
import { acEvoRecordingSupport } from "@raceiq/game-ac-evo/test-support/recordings";
import { f1RecordingSupport } from "@raceiq/game-f1-2025/test-support/recordings";
import { fmRecordingSupport } from "@raceiq/game-fm-2023/test-support/recordings";
import { iracingRecordingSupport } from "@raceiq/game-iracing/test-support/recordings";
import { lmuRecordingSupport } from "@raceiq/game-lmu/test-support/recordings";
/**
 * Usage: bun scripts/telemetry/recordings/probe-recording.ts <gameId> [path]
 *
 * If path is omitted, uses the latest recording for that game:
 *   bun scripts/telemetry/recordings/probe-recording.ts acc
 *   bun scripts/telemetry/recordings/probe-recording.ts f1-2025 test/artifacts/sessions/dump.bin
 */
import { initGameAdapters } from "@raceiq/shared/games/init";
import { initServerGameAdapters } from "../../../src/games/init";
import { developmentReleaseFeatures } from "@raceiq/tooling/release/development-release-features";
import { parseDump } from "@raceiq/backend-core/test-support/recordings/parse-dump";
import type { GameId } from "@raceiq/shared/games/ids";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const recordingGames = {
  "acc": accRecordingSupport,
  "ac-evo": acEvoRecordingSupport,
  "f1-2025": f1RecordingSupport,
  "fm-2023": fmRecordingSupport,
  "iracing": iracingRecordingSupport,
  "lmu": lmuRecordingSupport,
};

const gameId = process.argv[2] as GameId;
if (!gameId) {
  console.error("Usage: bun apps/backend/apps/backend/scripts/telemetry/recordings/probe-recording.ts <gameId> [path]");
  process.exit(1);
}

function latestForGame(gameId: string): string | null {
  if (gameId === "acc") {
    const dir = "test/artifacts/sessions";
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".bin")).sort().reverse();
    return files.length > 0 ? join(dir, files[0]) : null;
  }
  const dir = "test/artifacts/sessions";
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
initGameAdapters(developmentReleaseFeatures);
initServerGameAdapters(developmentReleaseFeatures);
const laps = await parseDump(recordingGames[gameId], path);
console.log(JSON.stringify(laps, null, 2));
