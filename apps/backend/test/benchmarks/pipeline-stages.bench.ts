import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { beginMemoryWindow, type MemorySample } from "./pipeline-stages-memory-sampler";
import { MEMORY_LIMITATIONS, MEMORY_TRIALS, profileEngineMemory, type MemoryEngine, type PipelineGame, type PipelineStage, type StageMemory } from "./pipeline-stages-memory";

const ROOT = resolve(import.meta.dir, "../../../../");
const FIXTURES = [
  { gameId: "fm-2023", fixture: "fm-2023-2026-04-09T21-53-00-102Z.bin.gz" },
  { gameId: "f1-2025", fixture: "f1-2025-2026-04-09T21-34-10-190Z.bin.gz" },
  { gameId: "acc", fixture: "acc-2026-04-23T16-42-16-158Z.bin.gz" },
  { gameId: "ac-evo", fixture: "session-ac-evo-menu-exit-2026-04-23T18-11-48-959Z.bin.gz" },
  { gameId: "iracing", fixture: "iracing-daytona-am-vantage-gt3-pit.bin.gz" },
  { gameId: "lmu", fixture: "lmu-spa-iron-lynx-gte.bin.gz" },
] as const;
type Kind = "frame" | "context" | "segment";
type StageRecord = { kind: Kind; payloadBase64?: string; timeMs?: number; offset: number };
type Args = { engine: "bun" | "rust" | "both"; game?: string; trials: number; frames: number; memory: "off" | "on"; output: string };
const internalMemoryChild = process.env.RACEIQ_PIPELINE_MEMORY_CHILD === "1";
function summarizeMemory(samples: MemorySample[]): StageMemory {
  const peaks = samples.map((sample) => sample.peakAdditionalBytes).sort((a, b) => a - b);
  const retained = samples.map((sample) => sample.retainedAdditionalBytes).sort((a, b) => a - b);
  return { samples, peakAdditionalBytes: peaks.at(-1)!, retainedAdditionalBytes: retained[Math.floor(retained.length / 2)]! };
}
const CHUNK_PACKETS = 500;

function args(argv: string[]): Args {
  const values: { [key: string]: string } = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) throw Error(`Unknown argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq < 0) throw Error(`Options require --name=value: ${arg}`);
    const key = arg.slice(2, eq);
    if (!["engine", "game", "trials", "frames", "memory", "output"].includes(key) || key in values) throw Error(`Unknown or duplicate option: --${key}`);
    values[key] = arg.slice(eq + 1);
  }
  const engine = values.engine ?? "both";
  if (!["bun", "rust", "both"].includes(engine)) throw Error("--engine must be bun|rust|both");
  const memory = values.memory ?? "on";
  if (memory !== "on" && memory !== "off") throw Error("--memory must be on|off");
  const trials = Number(values.trials ?? 20), frames = Number(values.frames ?? 10000);
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 100) throw Error("--trials must be between 1 and 100");
  if (!Number.isSafeInteger(frames) || frames < 1) throw Error("--frames must be a positive integer");
  if (!values.output) throw Error("--output=<path> is required");
  if (values.game && !FIXTURES.some((g) => g.gameId === values.game)) throw Error(`Unknown game ${values.game}`);
  return { engine: engine as Args["engine"], trials, frames, memory, output: resolve(values.output), ...(values.game ? { game: values.game } : {}) };
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

// Module paths that bind DATA_DIR are imported only after safe isolation.
const priorDataDir = process.env.DATA_DIR;
const isolatedDataDir = mkdtempSync(join(internalMemoryChild && process.env.RACEIQ_PIPELINE_MEMORY_TEMP_DIR ? process.env.RACEIQ_PIPELINE_MEMORY_TEMP_DIR : tmpdir(), "raceiq-pipeline-stages-"));
process.env.DATA_DIR = isolatedDataDir;
let child: ChildProcess | undefined;
let nativeClosed: Promise<void> | undefined;
let stopMaintenanceTasks: (() => void) | undefined;
const originalLog = console.log;
const originalWarn = console.warn;
try {
  const [{ initGameAdapters }, { initServerGameAdapters }, registry, framing, udp, pipelineModule, ports, iracing, lmu] = await Promise.all([
    import("@raceiq/game-catalogs/games/init"), import("../../src/games/init"),
    import("@raceiq/backend-core/games/registry"), import("@raceiq/backend-core/session-capture/framing"),
    import("@raceiq/backend-core/test-support/recordings/udp"), import("@raceiq/backend-core/telemetry/live-pipeline"),
    import("@raceiq/backend-core/telemetry/pipeline-ports"),
    import("@raceiq/capture-formats/iracing/dump"), import("@raceiq/capture-formats/lmu/dump"),
  ]);
  initGameAdapters(); initServerGameAdapters();
  stopMaintenanceTasks = pipelineModule.stopMaintenanceTasks;
  stopMaintenanceTasks();
  // Match the original pipeline benchmark: exclude pipeline logging I/O.
  console.log = () => {};
  console.warn = () => {};
  const config = args(process.argv.slice(2));
  if (internalMemoryChild && (config.engine === "both" || !config.game || config.trials !== MEMORY_TRIALS || config.memory !== "off")) throw Error("Internal memory child requires one engine/game, three trials and --memory=off");
  const selected = FIXTURES.filter((g) => !config.game || config.game === g.gameId);
  const normalBinary = resolve(ROOT, "native/recorder/target/release", process.platform === "win32" ? "raceiq-recorder.exe" : "raceiq-recorder");
  const memoryBinary = resolve(ROOT, "native/recorder/target/release", process.platform === "win32" ? "raceiq-pipeline-memory.exe" : "raceiq-pipeline-memory");
  const binary = internalMemoryChild && config.engine === "rust" ? memoryBinary : normalBinary;
  const rustRequested = config.engine !== "bun";
  if (rustRequested && !existsSync(binary)) throw Error(`Missing ${internalMemoryChild ? "instrumented memory" : "release"} native executable: ${binary}`);
  let pending: ((line: string) => void) | undefined;
  let nativeFailure: ((error: Error) => void) | undefined;
  let nativeError: Error | undefined;
  if (rustRequested) {
    child = spawn(binary, ["--pipeline-benchmark-stdio"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    if (internalMemoryChild && config.engine === "rust" && process.send) {
      const started = { type: "pipeline-memory-native-started", pid: child.pid, executable: binary };
      process.send(started);
      await new Promise<void>((resolve, reject) => {
        const listener = (message: unknown) => {
          if (message && typeof message === "object" && "type" in message && message.type === "pipeline-memory-native-continue") {
            clearTimeout(timer);
            process.off("message", listener);
            resolve();
          }
        };
        const timer = setTimeout(() => { process.off("message", listener); reject(Error("Timed out waiting for native memory startup acknowledgement")); }, 10_000);
        process.on("message", listener);
      });
    }
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => { const resolveLine = pending; pending = undefined; resolveLine?.(line); });
    child.stderr!.on("data", (chunk) => process.stderr.write(chunk));
    const { promise: closed, resolve: resolveClose, reject: rejectClose } = Promise.withResolvers<void>();
    nativeClosed = closed;
    void closed.catch(() => undefined);
    child!.once("error", (error) => { nativeError = error; nativeFailure?.(error); rejectClose(error); });
    child!.once("exit", (code, signal) => {
      const error = new Error(`Native benchmark exited (${code ?? signal})`);
      nativeError = error;
      if (pending) { nativeFailure?.(error); pending = undefined; }
      if (code !== 0) rejectClose(error); else resolveClose();
    });
    nativeFailure = (error) => { const reject = pending; pending = undefined; reject?.(JSON.stringify({ error: error.message })); };
  }
  async function rustRun(gameId: string, records: StageRecord[]) {
    if (nativeError) throw nativeError;
    const { promise, resolve: resolveLine, reject: rejectLine } = Promise.withResolvers<string>();
    pending = resolveLine;
    nativeFailure = rejectLine;
    child!.stdin!.write(JSON.stringify({ gameId, records, trials: config.trials, chunkPackets: CHUNK_PACKETS, memoryProfile: internalMemoryChild }) + "\n", (error) => { if (error) { pending = undefined; rejectLine(error); } });
    const replyLine = await promise;
    const reply = JSON.parse(replyLine);
    if (reply.error) throw Error(`Rust ${gameId}: ${reply.error}`);
    return reply;
  }
  const report = { benchmark: "purposeful pipeline stages", runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, pid: process.pid, nativePid: child?.pid ?? null, nativeExecutable: rustRequested ? binary : null, nativeProfile: rustRequested ? "release" : null }, config: { engine: config.engine, game: config.game ?? "all", frames: config.frames, trials: config.trials, memory: config.memory }, trials: config.trials, warmups: 1, chunkPackets: CHUNK_PACKETS, enginesSequential: true, scope: { bun: "full-presentation parsing and LiveTelemetryPipeline orchestration/normalization", rust: "GameParser full-presentation parse and Detector/event processing", parity: "Not feature/semantic equivalent; compare measured scopes and report packet counts; no assumed speedup.", memory: MEMORY_LIMITATIONS }, games: [] as PipelineGame[], errors: [] as { gameId: string; engine?: MemoryEngine; phase?: string; error: string }[] };
  for (const fixture of selected) {
    try {
      const fixturePath = join(ROOT, "test/artifacts/sessions", fixture.fixture);
      if (!existsSync(fixturePath)) throw Error(`Missing fixture: ${fixturePath}`);
      const compressed = readFileSync(fixturePath);
      const bytes = framing.decompressIfGzipSync(compressed);
      const records: StageRecord[] = [];
      const frameBuffers: Array<Buffer | null> = [];
      let sourceFrames = 0;
      if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xffffffff && bytes.readUInt32LE(4) === 4) {
        let inContext = false;
        for (const record of framing.iterateSessionCaptureRecords(bytes)) {
          if (record.kind === "segment-boundary") { records.push({ kind: "segment", offset: record.offset }); frameBuffers.push(null); inContext = false; }
          else if (record.kind === "segment-context") inContext = true;
          else if (record.kind === "segment-context-end") inContext = false;
          else {
            if (!inContext && sourceFrames >= config.frames) break;
            const payload = Buffer.from(record.frame);
            records.push({ kind: inContext ? "context" : "frame", payloadBase64: payload.toString("base64"), offset: record.offset, ...(record.frameTimeMs === undefined ? {} : { timeMs: record.frameTimeMs }) });
            frameBuffers.push(payload);
            if (!inContext) sourceFrames++;
          }
        }
      } else if (fixture.gameId === "iracing") {
        let offset = 16;
        for (const frame of iracing.readIRacingFramesFromBuffer(bytes).slice(0, config.frames)) { const payload = Buffer.from(frame); records.push({ kind: "frame", payloadBase64: payload.toString("base64"), offset: offset + 5 }); frameBuffers.push(payload); sourceFrames++; offset += frame.length + 5; }
      } else if (fixture.gameId === "lmu") {
        let offset = 16;
        for (const frame of lmu.readLMUFramesFromBuffer(bytes).slice(0, config.frames)) { const payload = Buffer.from(frame); records.push({ kind: "frame", payloadBase64: payload.toString("base64"), offset: offset + 5 }); frameBuffers.push(payload); sourceFrames++; offset += frame.length + 5; }
      } else {
        const frames = udp.readUdpDump(fixturePath, config.frames);
        let offset = 0;
        for (const frame of frames) { const payload = Buffer.from(frame); records.push({ kind: "frame", payloadBase64: payload.toString("base64"), offset: offset + 4 }); frameBuffers.push(payload); sourceFrames++; offset += frame.length + 4; }
      }
      if (!sourceFrames) throw Error("Empty source-frame workload");
      const workloadHash = hash(Buffer.from(JSON.stringify(records)));
      const game = registry.getServerGame(fixture.gameId);
      const gameReport: PipelineGame = { gameId: fixture.gameId, fixture: fixture.fixture, sourceHash: hash(compressed), workloadHash, sourceFrames, records: records.length, contextRecords: records.filter((r) => r.kind === "context").length, segmentRecords: records.filter((r) => r.kind === "segment").length, engines: {} };
      if (config.engine !== "rust") {
      const bunParse: { elapsedSeconds: number; acceptedPackets: number }[] = [];
      let expectedParse: number | undefined;
      let parseMemorySamples: MemorySample[] = [];
      let pipelineMemorySamples: MemorySample[] = [];
      for (let i = 0; i <= config.trials; i++) {
        const retention = internalMemoryChild && i > 0 ? { state: null as unknown, output: undefined as unknown } : undefined;
        const memoryWindow = retention ? beginMemoryWindow(() => retention) : undefined;
        let state = game.createParserState?.() ?? null;
        let currentOutput: unknown;
        const start = performance.now();
        let count = 0;
        for (let index = 0; index < records.length; index++) {
          const record = records[index]!;
          if (record.kind === "segment") { state = game.createParserState?.() ?? null; continue; }
          currentOutput = game.tryParse(frameBuffers[index]!, state);
          if (currentOutput && record.kind === "frame") count++;
          if (memoryWindow && index % CHUNK_PACKETS === 0) { retention!.state = state; retention!.output = currentOutput; memoryWindow.sample(); }
        }
        const elapsedSeconds = (performance.now() - start) / 1000;
        if (memoryWindow) {
          retention!.state = state;
          retention!.output = currentOutput;
          memoryWindow.sample();
          // Match Rust's retained parser state: returned output is transient.
          retention!.output = undefined;
          currentOutput = undefined;
          parseMemorySamples.push(memoryWindow.finish());
        }
        if (expectedParse !== undefined && count !== expectedParse) throw Error("Bun parse accepted count drift");
        expectedParse = count;
        if (i) bunParse.push({ elapsedSeconds, acceptedPackets: count });
      }
      if (!expectedParse) throw Error("Bun parser accepted zero packets; increase --frames");
      let state = game.createParserState?.() ?? null;
      const packetChunks: unknown[][] = [];
      let packetChunk: unknown[] = [];
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (record.kind === "segment") {
          if (packetChunk.length) packetChunks.push(packetChunk);
          packetChunk = [];
          state = game.createParserState?.() ?? null;
          continue;
        }
        const packet = game.tryParse(frameBuffers[i]!, state);
        if (packet && record.kind === "frame") {
          packetChunk.push(structuredClone(packet));
          if (packetChunk.length === CHUNK_PACKETS) { packetChunks.push(packetChunk); packetChunk = []; }
        }
      }
      if (packetChunk.length) packetChunks.push(packetChunk);
      const makeChunks = () => packetChunks.map((packets) => packets.map((packet) => structuredClone(packet)));
      const bunPipeline: { elapsedSeconds: number; processedPackets: number }[] = [];
      let stableProcessed: number | undefined;
      for (let i = 0; i <= config.trials; i++) {
        const preparedChunks = makeChunks();
        let retainedChunks: unknown;
        const memoryWindow = internalMemoryChild && i > 0 ? beginMemoryWindow(() => retainedChunks) : undefined;
        const chunks: { packets: (typeof preparedChunks)[number]; pipeline?: InstanceType<typeof pipelineModule.LiveTelemetryPipeline> }[] = preparedChunks.map((packets) => ({ packets, pipeline: new pipelineModule.LiveTelemetryPipeline(new ports.NullDbAdapter(), new ports.NullWsAdapter(), { bypassPacketRateFilter: true, skipHistorySeeding: true, skipDevState: true, recorder: new ports.NullSessionRecorderAdapter() }) }));
        retainedChunks = chunks;
        memoryWindow?.sample();
        const start = performance.now();
        let processed = 0;
        for (const chunk of chunks) {
          const { packets } = chunk;
          const pipeline = chunk.pipeline!;
          let firstPacket = true;
          for (const packet of packets) {
            await pipeline.processPacket(packet as never); processed++;
            if (memoryWindow && (firstPacket || processed % CHUNK_PACKETS === 0)) {
              memoryWindow.sample();
              firstPacket = false;
            }
          }
          await pipeline.flushIncompleteLap();
          if (memoryWindow) memoryWindow.sample();
          // Keep only the final chunk's state for the retained-memory sample.
          if (chunk !== chunks[chunks.length - 1]) chunk.pipeline = undefined;
        }
        const elapsedSeconds = (performance.now() - start) / 1000;
        if (memoryWindow) pipelineMemorySamples.push(memoryWindow.finish());
        if (stableProcessed !== undefined && processed !== stableProcessed) throw Error("Bun processing count drift");
        stableProcessed = processed;
        if (processed !== expectedParse) throw Error("Bun processing count differs from parser");
        chunks.length = 0;
        preparedChunks.length = 0;
        if (i) bunPipeline.push({ elapsedSeconds, processedPackets: processed });
      }
      if (expectedParse !== undefined && packetChunks.reduce((total, chunk) => total + chunk.length, 0) !== expectedParse) throw Error("Bun parse/preparation accepted count mismatch");
      const bunMemory = { metric: "bun-post-gc-live-heap-bytes" as const, parse: summarizeMemory(parseMemorySamples), pipeline: summarizeMemory(pipelineMemorySamples) };
      gameReport.engines.bun = { parse: stage(bunParse, "acceptedPackets", sourceFrames), pipeline: stage(bunPipeline, "processedPackets", stableProcessed!), ...(internalMemoryChild ? { memory: { method: "stage-code-memory-v4" as const, ...bunMemory, pid: process.pid, hostPid: process.pid, nativeProfile: null, nativeExecutable: null, profileTrials: MEMORY_TRIALS, exclusions: "Fixture loading, decoding, and prepared inputs excluded. Completed chunk state released; only final chunk state retained at stage end.", limitations: MEMORY_LIMITATIONS } } : {}) };
      }
      if (rustRequested) {
        const reply = await rustRun(fixture.gameId, records);
        if (reply.sourceFrames !== sourceFrames) throw Error("Rust source frame count mismatch");
        for (const [name, rows, key] of [["parse", reply.parse, "acceptedPackets"], ["pipeline", reply.pipeline, "processedPackets"]] as const) {
          if (!Array.isArray(rows) || rows.length !== config.trials) throw Error(`Rust ${name} sample count mismatch`);
          const counts = rows.map((x: { acceptedPackets?: number; processedPackets?: number }) => x[key]);
          if (counts.some((x) => x !== counts[0]) || !counts[0]) throw Error(`Rust ${name} count drift/empty result`);
          if (rows.some((sample: { elapsedSeconds: number }) => !Number.isFinite(sample.elapsedSeconds) || sample.elapsedSeconds <= 0)) throw Error(`Rust ${name} invalid elapsed sample`);
        }
        if (reply.acceptedPackets !== reply.parse[0].acceptedPackets || reply.pipeline[0].processedPackets !== reply.acceptedPackets) throw Error("Rust accepted/processed packet count mismatch");
        const rustMemory = reply.memory ? { ...reply.memory, method: "stage-code-memory-v4" as const, pid: child?.pid ?? process.pid, hostPid: process.pid, nativeProfile: "release", nativeExecutable: binary, profileTrials: MEMORY_TRIALS, exclusions: "Fixture loading, decoding, and prepared inputs excluded. Completed chunk state released; only final chunk state retained at stage end.", limitations: MEMORY_LIMITATIONS } : undefined;
        gameReport.engines.rust = { parse: stage(reply.parse, "acceptedPackets", sourceFrames), pipeline: stage(reply.pipeline, "processedPackets", reply.pipeline[0].processedPackets), ...(internalMemoryChild && rustMemory ? { memory: rustMemory } : {}) };
      }
      report.games.push(gameReport);
    } catch (error) { report.errors.push({ gameId: fixture.gameId, error: error instanceof Error ? error.message : String(error) }); }
  }
  // Throughput timing completes before separate fresh-process code-memory profiles.
  if (config.memory === "on" && !internalMemoryChild) {
    const engines: MemoryEngine[] = config.engine === "both" ? ["bun", "rust"] : [config.engine];
    for (const game of report.games) {
      for (const engine of engines) {
        try {
          if (!game.engines[engine]) throw Error(`Missing ${engine} throughput result`);
          game.engines[engine].memory = await profileEngineMemory({ runner: import.meta.path, engine, frames: config.frames, game });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (game.engines[engine]) game.engines[engine].memory = { error: message };
          report.errors.push({ gameId: game.gameId, engine, phase: "memory", error: message });
        }
      }
    }
  }
  if (!report.games.length || report.errors.length) process.exitCode = 1;
  if (config.engine === "both") for (const game of report.games) if (game.engines.rust && game.engines.bun && (game.engines.rust.parse.acceptedPackets !== game.engines.bun.parse.acceptedPackets || game.engines.rust.pipeline.processedPackets !== game.engines.bun.pipeline.processedPackets)) game.crossEngineCountMismatch = true;
  const out = JSON.stringify(report, null, 2) + "\n";
  await Bun.write(config.output, out);
  if (!internalMemoryChild) {
    console.log = originalLog;
    console.warn = originalWarn;
    console.log(`Pipeline stages (${config.trials} timing trials; memory ${config.memory}, separate ${MEMORY_TRIALS}-trial profiles)`);
    console.table(report.games.map((game) => {
      const row: Record<string, string> = { game: game.gameId };
      for (const engine of ["bun", "rust"] as const) {
        const result = game.engines[engine];
        const memory = result?.memory;
        row[`${engine} parse ms`] = result ? (result.parse.medianSeconds * 1000).toFixed(3) : "n/a";
        row[`${engine} processing ms`] = result ? (result.pipeline.medianSeconds * 1000).toFixed(3) : "n/a";
        row[`${engine} parse retained MiB`] = memory ? ("error" in memory ? "failed" : (memory.parse.retainedAdditionalBytes / 1048576).toFixed(3)) : "n/a";
        row[`${engine} processing retained MiB`] = memory ? ("error" in memory ? "failed" : (memory.pipeline.retainedAdditionalBytes / 1048576).toFixed(3)) : "n/a";
      }
      return row;
    }));
    if (config.memory === "on") {
      console.log("Diagnostic maxima only: Bun sampled post-GC maximum vs Rust allocation peak; not equivalent transient peaks.");
      console.table(report.games.map((game) => {
        const row: Record<string, string> = { game: game.gameId };
        for (const engine of ["bun", "rust"] as const) {
          const memory = game.engines[engine]?.memory;
          const label = engine === "bun" ? "sampled post-GC max" : "allocation peak";
          for (const stageName of ["parse", "pipeline"] as const) {
            const stageLabel = stageName === "parse" ? "parse" : "processing";
            row[`${engine} ${stageLabel} ${label} MiB`] = memory ? ("error" in memory ? "failed" : (memory[stageName].peakAdditionalBytes / 1048576).toFixed(3)) : "n/a";
          }
        }
        return row;
      }));
    }
  }
  if (report.errors.length) console.error(`${report.errors.length} benchmark error(s); details: ${config.output}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  if (child) {
    child.stdin?.end();
    const terminate = setTimeout(() => child?.kill("SIGTERM"), 2000); terminate.unref();
    const kill = setTimeout(() => child?.kill("SIGKILL"), 5000); kill.unref();
    try { await nativeClosed; } catch {}
    clearTimeout(terminate);
    clearTimeout(kill);
  }
  stopMaintenanceTasks?.();
  if (priorDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorDataDir;
  rmSync(isolatedDataDir, { recursive: true, force: true });
}
function stage(rows: { elapsedSeconds: number; acceptedPackets?: number; processedPackets?: number }[], countKey: "acceptedPackets" | "processedPackets", frames: number): PipelineStage {
  if (!rows.length || rows.some((row) => !Number.isFinite(row.elapsedSeconds) || row.elapsedSeconds <= 0)) throw Error("Stage samples must be positive and finite");
  const samples = rows.map((row) => row.elapsedSeconds);
  const count = rows[0]?.[countKey] ?? 0;
  const medianSeconds = median(samples);
  return { samplesSeconds: samples, medianSeconds, [countKey]: count, nsPerFrame: frames ? medianSeconds * 1e9 / frames : null, nsPerPacket: count ? medianSeconds * 1e9 / count : null };
}
