import { bench, group, do_not_optimize } from "mitata";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { LiveTelemetryPipeline, stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { NullDbAdapter, NullWsAdapter, NullSessionRecorderAdapter } from "../../server/telemetry/pipeline-ports";
import { readUdpDump } from "../support/recordings/udp";
import { parseAccBuffers } from "../../server/games/acc/parser";
import { readWString } from "../../server/games/acc/utils";
import { STATIC } from "../../server/games/acc/structs";
import { readKunosFrames } from "../../server/games/kunos/frame-reader";
import { getAccCarByModel } from "../../shared/racing/cars/acc";
import { getAccTrackByName } from "../../shared/racing/tracks/catalogs/acc";
import { parseAcEvoBuffers, createAcEvoParserCache } from "../../server/games/ac-evo/parser";
import { runMitataBenchmarks } from "./mitata-harness";
import { createBoundedPipelineRunner } from "./pipeline-bench-support";

const t0 = performance.now();
const elapsed = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`;

// --- Init ---
initGameAdapters();
initServerGameAdapters();
console.log(`[bench] adapters init ${elapsed()}`);

const N_FRAMES = 5000;

// --- Load and extract FM data ---
const FM_DUMP = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const fmAdapter = getAllServerGames().find((a) => a.canHandle(readUdpDump(FM_DUMP, 1)[0]))!;
const fmPackets: ReturnType<typeof fmAdapter.tryParse>[] = [];
const fmBuffers: Buffer[] = [];
for (const buf of readUdpDump(FM_DUMP)) {
  const p = fmAdapter.tryParse(buf, null);
  if (p) {
    fmPackets.push(p);
    fmBuffers.push(buf);
  }
  if (fmPackets.length >= N_FRAMES) break;
}
console.log(`[bench] fm loaded  — ${fmPackets.length} packets (${fmBuffers.length} bufs) ${elapsed()}`);

// --- Load and extract F1 data (read until 1k parsed packets) ---
const F1_DUMP = "test/artifacts/sessions/f1-2025-2026-04-09T21-34-10-190Z.bin.gz";
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
    if (f1Packets.length >= N_FRAMES) break;
  }
}
console.log(`[bench] f1 loaded  — ${f1Packets.length} packets (${f1Buffers.length} bufs) ${elapsed()}`);

// --- Load and extract ACC data ---
const ACC_DUMP = "test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz";
const accFrames = readKunosFrames(ACC_DUMP, N_FRAMES);
if (accFrames.length === 0) throw new Error("No ACC frames found in dump");
const accCm = readWString(accFrames[0].staticData, STATIC.carModel.offset, STATIC.carModel.size);
const accTn = readWString(accFrames[0].staticData, STATIC.track.offset, STATIC.track.size);
const accOpts = {
  carOrdinal: accCm ? (getAccCarByModel(accCm)?.id ?? 0) : 0,
  trackOrdinal: accTn ? (getAccTrackByName(accTn)?.id ?? 0) : 0,
};
const accPackets = accFrames.map((f) => parseAccBuffers(f.physics, f.graphics, f.staticData, accOpts)).filter((p): p is NonNullable<typeof p> => p !== null);
console.log(`[bench] acc loaded — ${accPackets.length} packets, car: ${accCm ?? "?"} track: ${accTn ?? "?"} ${elapsed()}`);

// --- Load and extract AC Evo data (same recorder format as ACC) ---
const ACEVO_DUMP = "test/artifacts/sessions/ac-evo-2026-04-15T17-12-25-825Z.bin.gz";
const acEvoFrames = readKunosFrames(ACEVO_DUMP, N_FRAMES);
if (acEvoFrames.length === 0) throw new Error("No AC Evo frames found in dump");
const acEvoCache = createAcEvoParserCache();
const acEvoPackets = acEvoFrames.map((f) => parseAcEvoBuffers(f.physics, f.graphics, f.staticData, acEvoCache)).filter((p): p is NonNullable<typeof p> => p !== null);
console.log(`[bench] ac-evo loaded — ${acEvoPackets.length} packets ${elapsed()}`);



// --- Pre-warm pipelines with null adapters (no DB/WS IO) ---
const pipelineOpts = { bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, recorder: new NullSessionRecorderAdapter() };
const fmPipeline = new LiveTelemetryPipeline(new NullDbAdapter(), new NullWsAdapter(), pipelineOpts);
const f1Pipeline = new LiveTelemetryPipeline(new NullDbAdapter(), new NullWsAdapter(), pipelineOpts);
const accPipeline = new LiveTelemetryPipeline(new NullDbAdapter(), new NullWsAdapter(), pipelineOpts);
const acEvoPipeline = new LiveTelemetryPipeline(new NullDbAdapter(), new NullWsAdapter(), pipelineOpts);
await fmPipeline.processPacket(fmPackets[0]!);
await f1Pipeline.processPacket(f1Packets[0]!);
await accPipeline.processPacket(accPackets[0]!);
await acEvoPipeline.processPacket(acEvoPackets[0]!);
console.log(`[bench] pipelines warm ${elapsed()}`);

// Stop the default pipeline's maintenance interval (created at import time)
stopMaintenanceTasks();

// Pipeline detectors retain the in-progress lap. The fixture packets do not
// reliably cross lap boundaries, so periodically flush the synthetic lap to
// keep repeated benchmark iterations from turning detector state into a leak.
const PIPELINE_FLUSH_EVERY = 500;
const makePipelineRunner = (pipeline: LiveTelemetryPipeline) =>
  createBoundedPipelineRunner(pipeline, PIPELINE_FLUSH_EVERY);

// Parse benches are synchronous. Pipeline benches await the complete processing
// path and periodically flush synthetic detector state.

group("fm", () => {
  let i = 0;
  bench("parse", () => {
    const buf = fmBuffers[i];
    i = (i + 1) % fmBuffers.length;
    do_not_optimize(fmAdapter.tryParse(buf, null));
  });
  const runPipeline = makePipelineRunner(fmPipeline);
  let pi = 0;
  bench("pipeline", async () => {
    const packet = fmPackets[pi]!;
    pi = (pi + 1) % fmPackets.length;
    await runPipeline.run(packet);
  });
});

group("f1", () => {
  let i = 0;
  let state = f1Adapter.createParserState?.() ?? null;
  bench("parse", () => {
    const buf = f1Buffers[i];
    i++;
    if (i >= f1Buffers.length) {
      i = 0;
      state = f1Adapter.createParserState?.() ?? null;
    }
    do_not_optimize(f1Adapter.tryParse(buf, state));
  });
  const runPipeline = makePipelineRunner(f1Pipeline);
  let pi = 0;
  bench("pipeline", async () => {
    const packet = f1Packets[pi]!;
    pi = (pi + 1) % f1Packets.length;
    await runPipeline.run(packet);
  });
});

group("acc", () => {
  let i = 0;
  bench("parse", () => {
    const f = accFrames[i];
    i = (i + 1) % accFrames.length;
    do_not_optimize(parseAccBuffers(f.physics, f.graphics, f.staticData, accOpts));
  });
  const runPipeline = makePipelineRunner(accPipeline);
  let pi = 0;
  bench("pipeline", async () => {
    const packet = accPackets[pi]!;
    pi = (pi + 1) % accPackets.length;
    await runPipeline.run(packet);
  });
});

group("ac-evo", () => {
  let i = 0;
  const parseCache = createAcEvoParserCache();
  bench("parse", () => {
    const f = acEvoFrames[i];
    i = (i + 1) % acEvoFrames.length;
    do_not_optimize(parseAcEvoBuffers(f.physics, f.graphics, f.staticData, parseCache));
  });
  const runPipeline = makePipelineRunner(acEvoPipeline);
  let pi = 0;
  bench("pipeline", async () => {
    const packet = acEvoPackets[pi]!;
    pi = (pi + 1) % acEvoPackets.length;
    await runPipeline.run(packet);
  });
});



console.log(`[bench] starting run ${elapsed()}`);
// Silence pipeline logging (lap detector / session / sector spam) during Mitata iterations.
const _origLog = console.log;
const _origWarn = console.warn;
console.log = () => {};
console.warn = () => {};
await runMitataBenchmarks("bench-results.json");
console.log = _origLog;
console.warn = _origWarn;
console.log(`[bench] results written to bench-results.json ${elapsed()}`);

process.exit(0);
