import { run, bench, group } from "mitata";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { NullDbAdapter, NullWsAdapter } from "../../server/pipeline-adapters";
import { Pipeline, stopMaintenanceTasks } from "../../server/pipeline";
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

// --- Load FM data ---
const FM_DUMP = "test/artifacts/laps/fm-2023-2026-04-09T21-53-00-102Z.bin.gz";
const fmBuffers = readUdpDump(FM_DUMP);
const fmAdapter = getAllServerGames().find((a) => a.canHandle(fmBuffers[0]))!;
let fmBuf: Buffer | null = null;
for (const buf of fmBuffers) {
  if (fmAdapter.tryParse(buf, null)) { fmBuf = buf; break; }
}
if (!fmBuf) throw new Error("No parseable FM packet found");
console.log(`[bench] fm loaded  — ${fmBuffers.length} packets ${elapsed()}`);

// --- Load F1 data ---
const F1_DUMP = "test/artifacts/laps/f1-2025-2026-04-09T21-34-10-190Z.bin.gz";
const f1Buffers = readUdpDump(F1_DUMP);
const f1Adapter = getAllServerGames().find((a) => a.canHandle(f1Buffers[0]))!;
const f1Buf = f1Buffers[0];
const f1PipelineBufs: Buffer[] = [];
{
  const scanState = f1Adapter.createParserState?.() ?? null;
  for (const buf of f1Buffers) {
    f1PipelineBufs.push(buf);
    if (f1Adapter.tryParse(buf, scanState)) break;
  }
}
console.log(`[bench] f1 loaded  — ${f1Buffers.length} packets, pipeline slice: ${f1PipelineBufs.length} bufs ${elapsed()}`);

// --- Load ACC data ---
const ACC_DUMP = "test/artifacts/laps/acc-2026-04-10T02-55-22-777Z.bin.gz";
const accFrames = readAccFrames(ACC_DUMP, 1);
const accFrame = accFrames[0];
if (!accFrame) throw new Error("No ACC frames found in dump");
const accCm = readWString(accFrame.staticData, STATIC.carModel.offset, STATIC.carModel.size);
const accTn = readWString(accFrame.staticData, STATIC.track.offset, STATIC.track.size);
const accOpts = {
  carOrdinal: accCm ? (getAccCarByModel(accCm)?.id ?? 0) : 0,
  trackOrdinal: accTn ? (getAccTrackByName(accTn)?.id ?? 0) : 0,
};
console.log(`[bench] acc loaded — car: ${accCm ?? "?"} track: ${accTn ?? "?"} ${elapsed()}`);

// --- Pre-warm pipelines ---
console.log(`[bench] warming pipelines…`);
const fmPacket = fmAdapter.tryParse(fmBuf!, null)!;
const fmPipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), { bypassPacketRateFilter: true, skipHistorySeeding: true });
await fmPipeline.processPacket(fmPacket);
console.log(`[bench] fm  pipeline warm ${elapsed()}`);

const f1Pipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), { bypassPacketRateFilter: true, skipHistorySeeding: true });
{
  const warmState = f1Adapter.createParserState?.() ?? null;
  for (const buf of f1PipelineBufs) {
    const p = f1Adapter.tryParse(buf, warmState);
    if (p) { await f1Pipeline.processPacket(p); break; }
  }
}
console.log(`[bench] f1  pipeline warm ${elapsed()}`);

const accPipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), { bypassPacketRateFilter: true, skipHistorySeeding: true });
{
  const warmPacket = parseAccBuffers(accFrame.physics, accFrame.graphics, accFrame.staticData, accOpts);
  if (warmPacket) await accPipeline.processPacket(warmPacket);
}
console.log(`[bench] acc pipeline warm ${elapsed()}`);

// --- Benchmarks (all synchronous — avoids async event-loop hangs) ---
// Pipeline benches fire-and-forget: measures sync dispatch cost up to the first await.
// Parse benches are fully synchronous and measure raw decode throughput.

group("acc", () => {
  bench("parse", () => {
    parseAccBuffers(accFrame.physics, accFrame.graphics, accFrame.staticData, accOpts);
  });

  bench("pipeline", () => {
    const ld = accPipeline.lapDetector as any;
    if (ld?.lapBuffer?.length > 1) ld.lapBuffer.length = 1;
    const packet = parseAccBuffers(accFrame.physics, accFrame.graphics, accFrame.staticData, accOpts);
    if (packet) void accPipeline.processPacket(packet);
  });
});

group("fm", () => {
  bench("parse", () => {
    fmAdapter.tryParse(fmBuf!, null);
  });

  bench("pipeline", () => {
    const packet = fmAdapter.tryParse(fmBuf!, null)!;
    void fmPipeline.processPacket(packet);
  });
});

group("f1", () => {
  bench("parse", () => {
    f1Adapter.tryParse(f1Buf, f1Adapter.createParserState?.() ?? null);
  });

  bench("pipeline", () => {
    const state = f1Adapter.createParserState?.() ?? null;
    for (const buf of f1PipelineBufs) {
      const packet = f1Adapter.tryParse(buf, state);
      if (packet) { void f1Pipeline.processPacket(packet); break; }
    }
  });
});

console.log(`[bench] starting run ${elapsed()}`);
const results = await run({ time: 200 });

await Bun.write("bench-results.json", JSON.stringify(results, null, 2));
console.log(`[bench] results written to bench-results.json ${elapsed()}`);

stopMaintenanceTasks();
process.exit(0);
