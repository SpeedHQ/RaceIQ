import { run, bench, group } from "mitata";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { stopMaintenanceTasks } from "../../server/pipeline";
import { readUdpDump } from "../helpers/recording";
import { parseAccBuffers } from "../../server/games/acc/parser";
import { readWString } from "../../server/games/acc/utils";
import { STATIC } from "../../server/games/acc/structs";
import { readAccFrames } from "../../server/games/acc/frame-reader";
import { getAccCarByModel } from "../../shared/acc-car-data";
import { getAccTrackByName } from "../../shared/acc-track-data";

const t0 = performance.now();
const elapsed = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`;

// --- Init ---
initGameAdapters();
initServerGameAdapters();
console.log(`[bench] adapters init ${elapsed()}`);

// --- Load and extract FM data (read until 1k parsed packets) ---
const FM_DUMP = "test/artifacts/laps/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const fmAdapter = getAllServerGames().find((a) => a.canHandle(readUdpDump(FM_DUMP, 1)[0]))!;
const fmPackets: ReturnType<typeof fmAdapter.tryParse>[] = [];
const fmBuffers: Buffer[] = [];
for (const buf of readUdpDump(FM_DUMP)) {
  const p = fmAdapter.tryParse(buf, null);
  if (p) { fmPackets.push(p); fmBuffers.push(buf); }
  if (fmPackets.length >= 1000) break;
}
console.log(`[bench] fm loaded  — ${fmPackets.length} packets (${fmBuffers.length} bufs) ${elapsed()}`);

// --- Load and extract F1 data (read until 1k parsed packets) ---
const F1_DUMP = "test/artifacts/laps/f1-2025-2026-04-09T21-34-10-190Z.bin.gz";
const f1AllBuffers = readUdpDump(F1_DUMP);
const f1Adapter = getAllServerGames().find((a) => a.canHandle(f1AllBuffers[0]))!;
const f1Packets: ReturnType<typeof f1Adapter.tryParse>[] = [];
const f1Buffers: Buffer[] = [];
{
  const state = f1Adapter.createParserState?.() ?? null;
  for (const buf of f1AllBuffers) {
    f1Buffers.push(buf);
    const p = f1Adapter.tryParse(buf, state);
    if (p) f1Packets.push(p);
    if (f1Packets.length >= 1000) break;
  }
}
console.log(`[bench] f1 loaded  — ${f1Packets.length} packets (${f1Buffers.length} bufs) ${elapsed()}`);

// --- Load and extract ACC data ---
const ACC_DUMP = "test/artifacts/laps/acc-2026-04-10T02-55-22-777Z.bin.gz";
const accFrames = readAccFrames(ACC_DUMP, 1000);
if (accFrames.length === 0) throw new Error("No ACC frames found in dump");
const accCm = readWString(accFrames[0].staticData, STATIC.carModel.offset, STATIC.carModel.size);
const accTn = readWString(accFrames[0].staticData, STATIC.track.offset, STATIC.track.size);
const accOpts = {
  carOrdinal: accCm ? (getAccCarByModel(accCm)?.id ?? 0) : 0,
  trackOrdinal: accTn ? (getAccTrackByName(accTn)?.id ?? 0) : 0,
};
const accPackets = accFrames.map((f) => parseAccBuffers(f.physics, f.graphics, f.staticData, accOpts)).filter(Boolean);
console.log(`[bench] acc loaded — ${accPackets.length} packets, car: ${accCm ?? "?"} track: ${accTn ?? "?"} ${elapsed()}`);



// --- Benchmarks (all synchronous — avoids async event-loop hangs) ---
// Pipeline benches fire-and-forget: measures sync dispatch cost up to the first await.
// Parse benches are fully synchronous and measure raw decode throughput.

group("fm", () => {
  bench("parse 1k", () => {
    for (const buf of fmBuffers) fmAdapter.tryParse(buf, null);
  });
});

group("f1", () => {
  bench("parse 1k", () => {
    const state = f1Adapter.createParserState?.() ?? null;
    for (const buf of f1Buffers) f1Adapter.tryParse(buf, state);  // f1Buffers = bufs that produced 1k packets
  });
});

group("acc", () => {
  bench("parse 1k", () => {
    for (const f of accFrames) parseAccBuffers(f.physics, f.graphics, f.staticData, accOpts);
  });
});

console.log(`[bench] starting run ${elapsed()}`);
const results = await run({ time: 200 });

await Bun.write("bench-results.json", JSON.stringify(results, null, 2));
console.log(`[bench] results written to bench-results.json ${elapsed()}`);

stopMaintenanceTasks();
process.exit(0);
