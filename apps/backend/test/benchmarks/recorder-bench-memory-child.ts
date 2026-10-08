import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { GameId } from "@raceiq/shared/games/ids";

const [gameId, fixture] = Bun.argv.slice(2);
if (!gameId || !fixture) throw new Error("Expected game id and fixture path");
const dataDir = await mkdtemp(join(tmpdir(), "raceiq-memory-child-"));
process.env.DATA_DIR = dataDir;
let input: ReturnType<typeof createInterface> | undefined;
let stopMaintenanceTasks: (() => void) | undefined;
let closeDatabase: (() => void) | undefined;
try {
  // All database-dependent initialization follows isolated DATA_DIR setup.
  const { client } = await import("@raceiq/backend-core/db/index");
  closeDatabase = () => client.close();
  ({ stopMaintenanceTasks } = await import("@raceiq/backend-core/telemetry/live-pipeline"));
  const { runMemoryImport } = await import("./recorder-bench-import");
  const bytes = await readFile(fixture);
  input = createInterface({ input: process.stdin });
  const commands = input[Symbol.asyncIterator]();
  const send = (event: Record<string, unknown>) => process.stdout.write(`@recorder-memory ${JSON.stringify(event)}\n`);
  send({ event: "ready" });
  if ((await commands.next()).value !== "go") throw new Error("Expected go command");
  const result = await runMemoryImport(bytes, gameId as GameId);
  send({ event: "done", packetCount: result.packetCount, lapCount: result.laps.length });
  if ((await commands.next()).value !== "release") throw new Error("Expected release command");
  send({ event: "released", packetCount: result.packetCount, lapCount: result.laps.length });
} finally {
  try {
    input?.close();
  } finally {
    try {
      stopMaintenanceTasks?.();
    } finally {
      try {
        closeDatabase?.();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }
}
