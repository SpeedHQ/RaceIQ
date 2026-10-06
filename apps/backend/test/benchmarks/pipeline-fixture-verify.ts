import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "../../../../");
const EVIDENCE = join(ROOT, ".omp/evidence/rust-pipeline-optimization");
const FIXTURES = [
  { gameId: "fm-2023", fixture: "fm-2023-2026-04-09T21-53-00-102Z.bin.gz" },
  { gameId: "f1-2025", fixture: "f1-2025-2026-04-09T21-34-10-190Z.bin.gz" },
  { gameId: "acc", fixture: "acc-2026-04-23T16-42-16-158Z.bin.gz" },
  { gameId: "ac-evo", fixture: "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz" },
  { gameId: "iracing", fixture: "iracing-daytona-am-vantage-gt3-pit.bin.gz" },
  { gameId: "lmu", fixture: "lmu-spa-iron-lynx-gte.bin.gz" },
] as const;
type RecordRow = { kind: "frame" | "context" | "segment"; payloadBase64?: string; timeMs?: number; offset: number };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function firstDifference(a: unknown, b: unknown, path = "$ "): string | undefined {
  if (canonical(a) === canonical(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path.trim()} length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) { const difference = firstDifference(a[i], b[i], `${path}[${i}]`); if (difference) return difference; }
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(key in left) || !(key in right)) return `${path.trim()}.${key} missing on ${key in left ? "right" : "left"}`;
      const difference = firstDifference(left[key], right[key], `${path.trim()}.${key}`); if (difference) return difference;
    }
  }
  return `${path.trim()} differs: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

const mode = process.argv[2];
if (mode !== "baseline" && mode !== "verify" && mode !== "--self-test") throw Error("Usage: bun test/benchmarks/pipeline-fixture-verify.ts baseline|verify|--self-test [--frames=10000]");
if (mode === "--self-test") {
  const baseline = { packets: [{ frameIndex: 0, packet: { speed: 12, rpm: 5000 } }], events: [{ type: "lap", lap: 1 }] };
  const assert = (condition: boolean, name: string) => { if (!condition) throw Error(`Comparator self-test failed: ${name}`); };
  assert(!firstDifference({ packets: [{ packet: { rpm: 5000, speed: 12 }, frameIndex: 0 }], events: [{ lap: 1, type: "lap" }] }, baseline), "object key order");
  assert(!!firstDifference(baseline, { ...baseline, packets: [{ frameIndex: 0, packet: { speed: 12, rpm: 5001 } }] }), "packet numeric field");
  assert(!!firstDifference(baseline, { ...baseline, packets: [] }), "dropped accepted frame");
  assert(!!firstDifference(baseline, { ...baseline, packets: [{ frameIndex: 1, packet: { speed: 12, rpm: 5000 } }] }), "source-frame acceptance index");
  assert(!!firstDifference(baseline, { ...baseline, events: [{ type: "lap", lap: 2 }] }), "changed detector event");
  assert(!!firstDifference({ values: [1, 2] }, { values: [2, 1] }), "array ordering");
  console.log("fixture comparator self-tests passed");
  process.exit(0);
}
const frameArg = process.argv.find((arg) => arg.startsWith("--frames="));
const frameLimit = Number(frameArg?.slice(9) ?? 10000);
if (!Number.isSafeInteger(frameLimit) || frameLimit !== 10000) throw Error("Differential fixture harness requires --frames=10000 (default)");
const [{ initGameAdapters }, { initServerGameAdapters }, registry, framing, udp, iracing, lmu] = await Promise.all([
  import("@raceiq/game-catalogs/games/init"), import("../../src/games/init"),
  import("@raceiq/backend-core/games/registry"), import("@raceiq/backend-core/session-capture/framing"),
  import("@raceiq/backend-core/test-support/recordings/udp"), import("@raceiq/capture-formats/iracing/dump"),
  import("@raceiq/capture-formats/lmu/dump"),
]);
initGameAdapters(); initServerGameAdapters();
mkdirSync(EVIDENCE, { recursive: true });
const rust = join(ROOT, "native/recorder/target/release/examples/pipeline-fixture");
if (!existsSync(rust)) throw Error(`Missing release harness: ${rust}; build with cargo build --release --example pipeline-fixture --manifest-path native/recorder/Cargo.toml`);
let failures = 0;
for (const fixture of FIXTURES) {
  const fixturePath = join(ROOT, "test/artifacts/sessions", fixture.fixture);
  if (!existsSync(fixturePath)) throw Error(`Missing fixture ${fixturePath}`);
  const compressed = readFileSync(fixturePath);
  const bytes = framing.decompressIfGzipSync(compressed);
  const records: RecordRow[] = [];
  const frameBuffers: Array<Buffer | null> = [];
  let sourceFrames = 0;
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xffffffff && bytes.readUInt32LE(4) === 4) {
    let inContext = false;
    for (const record of framing.iterateSessionCaptureRecords(bytes)) {
      if (record.kind === "segment-boundary") { records.push({ kind: "segment", offset: record.offset }); frameBuffers.push(null); inContext = false; }
      else if (record.kind === "segment-context") inContext = true;
      else if (record.kind === "segment-context-end") inContext = false;
      else {
        if (!inContext && sourceFrames >= frameLimit) break;
        const payload = Buffer.from(record.frame);
        records.push({ kind: inContext ? "context" : "frame", payloadBase64: payload.toString("base64"), offset: record.offset, ...(record.frameTimeMs === undefined ? {} : { timeMs: record.frameTimeMs }) });
        frameBuffers.push(payload); if (!inContext) sourceFrames++;
      }
    }
  } else if (fixture.gameId === "iracing" || fixture.gameId === "lmu") {
    let offset = 16;
    const frames = fixture.gameId === "iracing" ? iracing.readIRacingFramesFromBuffer(bytes) : lmu.readLMUFramesFromBuffer(bytes);
    for (const frame of frames.slice(0, frameLimit)) { const payload = Buffer.from(frame); records.push({ kind: "frame", payloadBase64: payload.toString("base64"), offset: offset + 5 }); frameBuffers.push(payload); sourceFrames++; offset += frame.length + 5; }
  } else {
    let offset = 0;
    for (const frame of udp.readUdpDump(fixturePath, frameLimit)) { const payload = Buffer.from(frame); records.push({ kind: "frame", payloadBase64: payload.toString("base64"), offset: offset + 4 }); frameBuffers.push(payload); sourceFrames++; offset += frame.length + 4; }
  }
  if (!sourceFrames) throw Error(`${fixture.gameId}: empty fixture workload`);
  const input = JSON.stringify({ gameId: fixture.gameId, records }) + "\n";
  const child = spawnSync(rust, [], { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (child.status !== 0) throw Error(`${fixture.gameId}: native harness exited ${child.status}: ${child.stderr}`);
  const native = JSON.parse(child.stdout) as Record<string, unknown>;
  if (native.error) throw Error(`${fixture.gameId}: ${native.error}`);
  const baselinePath = join(EVIDENCE, `${fixture.gameId}.json`);
  const sourceHash = createHash("sha256").update(compressed).digest("hex");
  const workloadHash = createHash("sha256").update(JSON.stringify(records)).digest("hex");
  if (mode === "baseline") {
    writeFileSync(baselinePath, JSON.stringify({ fixture: fixture.fixture, sourceFrames, records: records.length, sourceHash, workloadHash, output: native }, null, 2) + "\n");
    console.log(`${fixture.gameId}: baseline written (${(native.packets as unknown[]).length} packets, ${(native.events as unknown[]).length} events)`);
  } else {
    if (!existsSync(baselinePath)) throw Error(`Missing baseline ${baselinePath}; run baseline mode first`);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { fixture: string; sourceHash: string; workloadHash: string; output: unknown };
    if (baseline.fixture !== fixture.fixture || baseline.sourceHash !== sourceHash || baseline.workloadHash !== workloadHash) {
      failures++;
      console.error(`${fixture.gameId}: baseline input/workload identity mismatch`);
    }
    const difference = firstDifference(baseline.output, native);
    if (difference) { failures++; console.error(`${fixture.gameId}: Rust baseline mismatch ${difference}`); }
    else console.log(`${fixture.gameId}: Rust baseline matches`);
  }
  // Cross-check Bun parser full presentation packets only; report differences without changing either output.
  const game = registry.getServerGame(fixture.gameId);
  let state = game.createParserState?.() ?? null;
  let sourceFrameIndex = 0;
  const bunPackets: unknown[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.kind === "segment") { state = game.createParserState?.() ?? null; continue; }
    const packet = game.tryParse(frameBuffers[i]!, state);
    if (packet && record.kind === "frame") bunPackets.push({ frameIndex: sourceFrameIndex, recordOffset: record.offset, packet: structuredClone(packet) });
    if (record.kind === "frame") sourceFrameIndex++;
  }
  const rustPackets = native.packets as unknown[];
  const mismatch = firstDifference(bunPackets, rustPackets);
  writeFileSync(join(EVIDENCE, `${fixture.gameId}.bun-comparison.json`), JSON.stringify({ fixture: fixture.fixture, sourceHash, workloadHash, comparedPackets: Math.min(bunPackets.length, rustPackets.length), bunPackets: bunPackets.length, rustPackets: rustPackets.length, mismatch: mismatch ?? null, limitation: "Full packet comparison only; detectors are not assumed feature-equivalent." }, null, 2) + "\n");
  if (mismatch) console.error(`${fixture.gameId}: Bun/Rust full packet difference (full-packet comparison only; detector semantics not compared): ${mismatch}`);
  else console.log(`${fixture.gameId}: Bun/Rust full packets match`);
}
if (failures) throw Error(`${failures} Rust baseline comparison(s) failed`);
