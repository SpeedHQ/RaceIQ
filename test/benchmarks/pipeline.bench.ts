import { run, bench, group } from "mitata";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { NullDbAdapter, NullWsAdapter } from "../../server/pipeline-adapters";
import { Pipeline } from "../../server/pipeline";
import { readUdpDump } from "../helpers/recording";

// --- Init ---
initGameAdapters();
initServerGameAdapters();

// --- Load FM data ---
const FM_DUMP = "test/artifacts/laps/fm-2023-2026-04-09T21-53-00-102Z.bin.gz";
const fmBuffers = readUdpDump(FM_DUMP);
const fmAdapter = getAllServerGames().find((a) => a.canHandle(fmBuffers[0]))!;
// Find first parseable FM buffer (stateless parser)
let fmBuf: Buffer | null = null;
for (const buf of fmBuffers) {
  if (fmAdapter.tryParse(buf, null)) { fmBuf = buf; break; }
}
if (!fmBuf) throw new Error("No parseable FM packet found");

// --- Load F1 data ---
const F1_DUMP = "test/artifacts/laps/f1-2025-2026-04-09T21-34-10-190Z.bin.gz";
const f1Buffers = readUdpDump(F1_DUMP);
const f1Adapter = getAllServerGames().find((a) => a.canHandle(f1Buffers[0]))!;
// Use first buffer — measures per-buffer dispatch cost (F1 is multi-packet, most calls return null)
const f1Buf = f1Buffers[0];

// ACC benchmarks are Windows-only (shared memory reader hangs on macOS).
// Add acc group in CI on Windows once GH Actions integration is wired up.

// --- Pre-warm pipelines (outside bench loops — steady-state cost only) ---
const fmPacket = fmAdapter.tryParse(fmBuf!, null)!;
const fmPipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), { bypassPacketRateFilter: true });
await fmPipeline.processPacket(fmPacket);

let f1Packet = null;
const f1InitState = f1Adapter.createParserState?.() ?? null;
for (const buf of f1Buffers) {
  const p = f1Adapter.tryParse(buf, f1InitState);
  if (p) { f1Packet = p; break; }
}
const f1Pipeline = new Pipeline(new NullDbAdapter(), new NullWsAdapter(), { bypassPacketRateFilter: true });
if (f1Packet) await f1Pipeline.processPacket(f1Packet);

// --- Benchmarks ---

group("fm", () => {
  bench("parse", () => {
    fmAdapter.tryParse(fmBuf!, null);
  });

  bench("pipeline", async () => {
    await fmPipeline.processPacket(fmPacket);
  });
});

group("f1", () => {
  bench("parse", () => {
    f1Adapter.tryParse(f1Buf, f1Adapter.createParserState?.() ?? null);
  });

  bench("pipeline", async () => {
    if (f1Packet) await f1Pipeline.processPacket(f1Packet);
  });
});

// --- Run and write JSON ---
const results = await run({ time: 500 });
await Bun.write("bench-results.json", JSON.stringify(results, null, 2));
console.log("\nResults written to bench-results.json");
process.exit(0);
