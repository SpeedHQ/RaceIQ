import { run, bench, group, do_not_optimize, measure } from "mitata";
import { B } from "mitata/src/main.mjs";

// Mitata's `run(opts)` does NOT forward sampling options to measurement. Its default
// `min_cpu_time` is 642ms per bench — async benches end up doing millions of iters and
// 30+ seconds each. Patch B.prototype.run to call measure() directly with our caps.
const BENCH_OPTS = { min_samples: 10, max_samples: 30, batch_samples: 10, min_cpu_time: 50_000_000 };
type BInternal = {
  _args: Record<string, unknown[]>; _name: string; _group: number; _gc: string | boolean;
  _highlight: unknown; flags: number; f: unknown;
};
(B.prototype as unknown as { run: (thrw?: boolean) => Promise<unknown> }).run = async function (this: BInternal, thrw = false) {
  const isStatic = Object.keys(this._args).length === 0;
  const tune: Record<string, unknown> = {
    inner_gc: this._gc === "inner",
    gc: !this._gc ? false : undefined,
    heap: globalThis.Bun
      ? await (async () => { const { memoryUsage } = await import("bun:jsc"); return () => memoryUsage().current; })()
      : undefined,
    ...BENCH_OPTS,
  };
  const baseline = !!(this.flags & 0x1);
  const style = { highlight: this._highlight, compact: !!(this.flags & 0x2) };
  if (isStatic) {
    let stats, error;
    try { stats = await measure(this.f as Parameters<typeof measure>[0], tune as unknown as Parameters<typeof measure>[1]); }
    catch (err) { error = err; if (thrw) throw err; }
    return { kind: "static", args: this._args, alias: this._name, group: this._group, baseline,
      runs: [{ stats, error, args: {}, name: this._name }], style };
  }
  throw new Error("parametric benches not supported in patched run()");
};
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { Pipeline, stopMaintenanceTasks } from "../../server/pipeline";
import { NullDbAdapter, NullWsAdapter } from "../../server/pipeline-adapters";
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

const N_FRAMES = 5000;

// --- Load and extract FM data ---
const FM_DUMP = "test/artifacts/laps/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const fmAdapter = getAllServerGames().find((a) => a.canHandle(readUdpDump(FM_DUMP, 1)[0]))!;
const fmPackets: ReturnType<typeof fmAdapter.tryParse>[] = [];
const fmBuffers: Buffer[] = [];
for (const buf of readUdpDump(FM_DUMP)) {
  const p = fmAdapter.tryParse(buf, null);
  if (p) { fmPackets.push(p); fmBuffers.push(buf); }
  if (fmPackets.length >= N_FRAMES) break;
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
    if (f1Packets.length >= N_FRAMES) break;
  }
}
console.log(`[bench] f1 loaded  — ${f1Packets.length} packets (${f1Buffers.length} bufs) ${elapsed()}`);

// --- Load and extract ACC data ---
const ACC_DUMP = "test/artifacts/laps/acc-2026-04-10T02-55-22-777Z.bin.gz";
const accFrames = readAccFrames(ACC_DUMP, N_FRAMES);
if (accFrames.length === 0) throw new Error("No ACC frames found in dump");
const accCm = readWString(accFrames[0].staticData, STATIC.carModel.offset, STATIC.carModel.size);
const accTn = readWString(accFrames[0].staticData, STATIC.track.offset, STATIC.track.size);
const accOpts = {
  carOrdinal: accCm ? (getAccCarByModel(accCm)?.id ?? 0) : 0,
  trackOrdinal: accTn ? (getAccTrackByName(accTn)?.id ?? 0) : 0,
};
const accPackets = accFrames
  .map((f) => parseAccBuffers(f.physics, f.graphics, f.staticData, accOpts))
  .filter((p): p is NonNullable<typeof p> => p !== null);
console.log(`[bench] acc loaded — ${accPackets.length} packets, car: ${accCm ?? "?"} track: ${accTn ?? "?"} ${elapsed()}`);

// --- Pre-warm pipelines with null adapters (no DB/WS IO) ---
const pipelineOpts = { bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true };
const fmPipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), pipelineOpts);
const f1Pipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), pipelineOpts);
const accPipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), pipelineOpts);
await fmPipeline.processPacket(fmPackets[0]!);
await f1Pipeline.processPacket(f1Packets[0]!);
await accPipeline.processPacket(accPackets[0]!);
console.log(`[bench] pipelines warm ${elapsed()}`);

// Stop the default pipeline's maintenance interval (created at import time)
stopMaintenanceTasks();

// --- Benchmarks (all synchronous — avoids async event-loop hangs) ---
// Pipeline benches fire-and-forget: measures sync dispatch cost up to the first await.
// Parse benches are fully synchronous and measure raw decode throughput.

group("fm", () => {
  let i = 0;
  bench("parse", () => {
    const buf = fmBuffers[i]; i = (i + 1) % fmBuffers.length;
    do_not_optimize(fmAdapter.tryParse(buf, null));
  });
  let pi = 0;
  bench("pipeline", async () => {
    const packet = fmPackets[pi]!; pi = (pi + 1) % fmPackets.length;
    await fmPipeline.processPacket(packet);
  });
});

group("f1", () => {
  let i = 0;
  let state = f1Adapter.createParserState?.() ?? null;
  bench("parse", () => {
    const buf = f1Buffers[i];
    i++;
    if (i >= f1Buffers.length) { i = 0; state = f1Adapter.createParserState?.() ?? null; }
    do_not_optimize(f1Adapter.tryParse(buf, state));
  });
  let pi = 0;
  bench("pipeline", async () => {
    const packet = f1Packets[pi]!; pi = (pi + 1) % f1Packets.length;
    await f1Pipeline.processPacket(packet);
  });
});

group("acc", () => {
  let i = 0;
  bench("parse", () => {
    const f = accFrames[i]; i = (i + 1) % accFrames.length;
    do_not_optimize(parseAccBuffers(f.physics, f.graphics, f.staticData, accOpts));
  });
  let pi = 0;
  bench("pipeline", async () => {
    const packet = accPackets[pi]!; pi = (pi + 1) % accPackets.length;
    await accPipeline.processPacket(packet);
  });
});

console.log(`[bench] starting run ${elapsed()}`);
// Silence pipeline logging (lap detector / session / sector spam) during mitata iterations.
const _origLog = console.log;
const _origWarn = console.warn;
console.log = () => {};
console.warn = () => {};
// Iteration cap is applied via the B.prototype.run patch above; no options passed to run().
const results = await run();
console.log = _origLog;
console.warn = _origWarn;

// Strip raw sample arrays (can be millions of entries → 30+MB files)
const slim = JSON.parse(JSON.stringify(results), (k, v) => (k === "samples" || k === "ticks" ? undefined : v));
await Bun.write("bench-results.json", JSON.stringify(slim, null, 2));
console.log(`[bench] results written to bench-results.json ${elapsed()}`);

process.exit(0);
