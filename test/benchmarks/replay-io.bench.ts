import { bench, do_not_optimize, group } from "mitata";
import { client, initDb } from "../../server/db";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { deleteSession, insertSession, updateSessionRawFile } from "../../server/db/session-queries";
import { _telemetryCacheForTest, clearRawFileCacheForTest } from "../../server/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../server/games/init";
import { queryLapTelemetryBySemanticId } from "../../server/telemetry/replay";
import { initGameAdapters } from "../../shared/games/init";
import { runMitataBenchmarks } from "./mitata-harness";

const FRAME_COUNT = 20_000;
const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";
const SEMANTIC_IDS = ["motion.speed", "inputs.accel", "inputs.brake", "inputs.gear", "inputs.clutch-percent", "timing.current-lap", "timing.lap-number", "timing.distance-traveled"] as const;

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function assertEnvelopeCount(count: number): void {
  if (count < FRAME_COUNT || count > FRAME_COUNT + 1) {
    throw new Error(`Replay I/O benchmark expected ${FRAME_COUNT}-${FRAME_COUNT + 1} envelopes, received ${count}`);
  }
}

if (process.env.RACEIQ_TEST_MODE !== "1") {
  throw new Error("Run replay I/O benchmark through `bun run bench:replay-io` so database state stays isolated");
}
initGameAdapters();
initServerGameAdapters();
await initDb();

const sessionId = await insertSession(1, 1, "ac-evo");
await updateSessionRawFile(sessionId, FIXTURE, "replay-io-benchmark");
const lapId = await insertLap(sessionId, 1, 90, true, 12, FRAME_COUNT);
const preflight = await queryLapTelemetryBySemanticId(lapId, SEMANTIC_IDS);
assertEnvelopeCount(preflight?.envelopes.length ?? 0);

group("replay I/O", () => {
  bench("SQLite + capture identity + cached packets", async () => {
    const replay = await queryLapTelemetryBySemanticId(lapId, SEMANTIC_IDS);
    if (!replay) throw new Error(`Replay I/O benchmark could not load lap ${lapId}`);
    do_not_optimize(replay.envelopes.length);
  }).gc("inner");

  bench("SQLite + file + gzip + parse + canonical replay", async () => {
    _telemetryCacheForTest.clear();
    clearRawFileCacheForTest();
    const replay = await queryLapTelemetryBySemanticId(lapId, SEMANTIC_IDS);
    if (!replay) throw new Error(`Replay I/O benchmark could not load lap ${lapId}`);
    do_not_optimize(replay.envelopes.length);
  }).gc("inner");
});

const originalLog = console.log;
const originalWarn = console.warn;
try {
  console.log = () => {};
  console.warn = () => {};
  await runMitataBenchmarks(argumentValue("--output") ?? "replay-io-results.json");
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  await deleteSession(sessionId);
  client.close();
}

console.log("[bench] replay I/O results written");
