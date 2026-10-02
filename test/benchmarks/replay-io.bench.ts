import { bench, do_not_optimize, group } from "mitata";
import { parseRawLapFrames } from "../../server/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../server/games/init";
import { initGameAdapters } from "../../shared/games/init";
import { runMitataBenchmarks } from "./mitata-harness";

const FRAME_COUNT = 20_000;
const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";
const RAW_BYTE_OFFSET = 12;

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function parseBenchmarkFrames(): Promise<void> {
  const packets = await parseRawLapFrames({
    rawFile: FIXTURE,
    source: null,
    gameId: "ac-evo",
    carOrdinal: 0,
    trackOrdinal: 0,
  }, RAW_BYTE_OFFSET, FRAME_COUNT);
  const expectedPacketCount = FRAME_COUNT + 1;
  if (packets.length !== expectedPacketCount) {
    throw new Error(`Replay I/O benchmark expected ${expectedPacketCount} packets, received ${packets.length}`);
  }
  do_not_optimize(packets.length);
}

initGameAdapters();
initServerGameAdapters();

group("replay I/O", () => {
  bench("Direct streaming raw parse", parseBenchmarkFrames).gc("inner");
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
}

console.log("[bench] replay I/O results written");

