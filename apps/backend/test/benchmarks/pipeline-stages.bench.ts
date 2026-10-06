import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { LiveTelemetryPipeline } from "@raceiq/backend-core/telemetry/live-pipeline";
import { do_not_optimize, measure } from "mitata";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MitataStatistics } from "./mitata-harness";
import { beginMemoryWindow, type MemorySample } from "./pipeline-stages-memory-sampler";
import { MEMORY_LIMITATIONS, MEMORY_TRIALS, profileBunMemory, type PipelineGame, type PipelineStage, type StageMemory } from "./pipeline-stages-memory";

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
type RecordItem = { kind: Kind; frame?: Buffer; timeMs?: number; offset: number };
type ParseInput = { records: RecordItem[]; states: unknown[] };
type PipelineChunk = { items: TelemetryPacket[]; pipeline?: LiveTelemetryPipeline };
type Config = { game?: string; trials: number; frames: number; memory: "off" | "on"; output: string };
const memoryChild = process.env.RACEIQ_PIPELINE_MEMORY_CHILD === "1";
const CHUNK_PACKETS = 500;
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function hashWorkload(records: RecordItem[]): string {
  const digest = createHash("sha256");
  for (const record of records) {
    digest.update(
      JSON.stringify([
        record.kind,
        record.timeMs ?? null,
        record.offset,
        record.frame?.byteLength ?? null,
      ]),
    );
    digest.update("\0");
    if (record.frame) digest.update(record.frame);
    digest.update("\0");
  }
  return digest.digest("hex");
}
function parseArgs(argv: string[]): Config {
  const values: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) {
      throw Error(`Options require --name=value: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq);
    if (!["game", "trials", "frames", "memory", "output"].includes(key) || key in values) {
      throw Error(`Unknown or duplicate option: --${key}`);
    }
    values[key] = arg.slice(eq + 1);
  }
  const trials = Number(values.trials ?? 20);
  const frames = Number(values.frames ?? 10000);
  const memory = values.memory ?? "on";
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 100) {
    throw Error("--trials must be between 1 and 100");
  }
  if (!Number.isSafeInteger(frames) || frames < 1) {
    throw Error("--frames must be a positive integer");
  }
  if (!values.output) {
    throw Error("--output=<path> is required");
  }
  if (memory !== "on" && memory !== "off") {
    throw Error("--memory must be on|off");
  }
  if (values.game && !FIXTURES.some((fixture) => fixture.gameId === values.game)) {
    throw Error(`Unknown game ${values.game}`);
  }
  return {
    ...(values.game ? { game: values.game } : {}),
    trials,
    frames,
    memory,
    output: resolve(values.output),
  };
}
function summarize(samples: MemorySample[]): StageMemory {
  const peaks = samples.map((sample) => sample.peakAdditionalBytes).sort((a, b) => a - b);
  const retained = samples.map((sample) => sample.retainedAdditionalBytes).sort((a, b) => a - b);
  return {
    samples,
    peakAdditionalBytes: peaks.at(-1)!,
    retainedAdditionalBytes: retained[Math.floor(retained.length / 2)]!,
  };
}
function stage(
  stats: MitataStatistics | undefined,
  key: "acceptedPackets" | "processedPackets",
  frames: number,
  count: number,
): PipelineStage {
  // Memory children collect no throughput timings. Public throughput summaries
  // use Mitata's exact p50 (not a second, independently calculated median).
  return {
    samplesSeconds: stats?.samples.map((nanoseconds) => nanoseconds / 1e9) ?? [],
    medianSeconds: stats ? stats.p50 / 1e9 : null,
    [key]: count,
    nsPerFrame: stats ? stats.p50 / frames : null,
    nsPerPacket: stats ? stats.p50 / count : null,
    ...(stats ? { mitata: stats } : {}),
  };
}
// Isolate DATA_DIR before importing backend modules that bind storage at module load.
const priorDataDir = process.env.DATA_DIR;
const memoryTempRoot =
  memoryChild && process.env.RACEIQ_PIPELINE_MEMORY_TEMP_DIR
    ? process.env.RACEIQ_PIPELINE_MEMORY_TEMP_DIR
    : tmpdir();
const isolatedDataDir = mkdtempSync(join(memoryTempRoot, "raceiq-pipeline-stages-"));
process.env.DATA_DIR = isolatedDataDir;

let stopMaintenanceTasks: (() => void) | undefined;
const originalLog = console.log;
const originalWarn = console.warn;

try {
  const [
    catalog,
    games,
    registry,
    framing,
    udp,
    ports,
    pipelineModule,
    iracing,
    lmu,
  ] = await Promise.all([
    import("@raceiq/game-catalogs/games/init"),
    import("../../src/games/init"),
    import("@raceiq/backend-core/games/registry"),
    import("@raceiq/backend-core/session-capture/framing"),
    import("@raceiq/backend-core/test-support/recordings/udp"),
    import("@raceiq/backend-core/telemetry/pipeline-ports"),
    import("@raceiq/backend-core/telemetry/live-pipeline"),
    import("@raceiq/capture-formats/iracing/dump"),
    import("@raceiq/capture-formats/lmu/dump"),
  ]);

  catalog.initGameAdapters();
  games.initServerGameAdapters();
  stopMaintenanceTasks = pipelineModule.stopMaintenanceTasks;
  stopMaintenanceTasks();
  console.log = () => {};
  console.warn = () => {};

  const config = parseArgs(process.argv.slice(2));
  if (
    memoryChild &&
    (!config.game || config.trials !== MEMORY_TRIALS || config.memory !== "off")
  ) {
    throw Error("Internal memory child requires one game, three trials and --memory=off");
  }
  const selected = FIXTURES.filter(
    (fixture) => !config.game || fixture.gameId === config.game,
  );
  // measure() accepts these options; run() does not forward sampling options.
  // Disable adaptive batching/trimming so --trials means exactly this many
  // measured full-workload samples, preceded by one excluded warmup.
  const measurementOptions = {
    min_samples: config.trials,
    max_samples: config.trials,
    min_cpu_time: 0,
    warmup_threshold: 0,
    batch_threshold: 0,
    batch_samples: 1,
    batch_unroll: 1,
    samples_threshold: config.trials,
  };
  const report = {
    benchmark: "purposeful pipeline stages",
    runtime: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    config: {
      game: config.game ?? "all",
      frames: config.frames,
      trials: config.trials,
      memory: config.memory,
    },
    warmups: 1,
    chunkPackets: CHUNK_PACKETS,
    measurement: memoryChild ? null : {
      library: "mitata",
      version: JSON.parse(readFileSync(Bun.resolveSync("mitata/package.json", import.meta.dir), "utf8")).version as string,
      api: "measure",
      units: "nanoseconds per full stage workload",
      computedParameters: true,
      options: measurementOptions,
      trials: "Fixed measured samples per stage; one excluded warmup; no batching or sample trimming. Memory profiling runs independently and provides no throughput timings.",
      rawResults: "games[].parse.mitata and games[].pipeline.mitata contain unchanged Mitata statistics, including samples, ticks, quantiles, and measurement debug source.",
    },
    scope: {
      parse: "Full-presentation server game adapter parsing with fresh parser state per invocation and segment; complete returned telemetry is consumed. Context frames prime state but are excluded from accepted packet count.",
      pipeline: "LiveTelemetryPipeline packet processing and normalization with null database, WebSocket, and session-recorder adapters; every packet and final incomplete-lap flush awaited, with fresh pipelines for at-most-500-packet chunks.",
      exclusions: "Fixture loading, decompression, framing, input cloning, workload preparation, parser-state construction, and pipeline construction excluded from throughput timings by Mitata computed parameters.",
    },
    memoryLimitations: MEMORY_LIMITATIONS,
    games: [] as PipelineGame[],
    errors: [] as { gameId: string; error: string }[],
  };

  for (const fixture of selected) {
    try {
      const path = join(ROOT, "test/artifacts/sessions", fixture.fixture);
      if (!existsSync(path)) {
        throw Error(`Missing fixture: ${path}`);
      }
      const compressed = readFileSync(path);
      const bytes = framing.decompressIfGzipSync(compressed);
      const records: RecordItem[] = [];
      let sourceFrames = 0;

      if (
        bytes.length >= 8 &&
        bytes.readUInt32LE(0) === 0xffffffff &&
        bytes.readUInt32LE(4) === 4
      ) {
        let inContext = false;
        for (const record of framing.iterateSessionCaptureRecords(bytes)) {
          if (record.kind === "segment-boundary") {
            records.push({ kind: "segment", offset: record.offset });
            inContext = false;
          } else if (record.kind === "segment-context") {
            inContext = true;
          } else if (record.kind === "segment-context-end") {
            inContext = false;
          } else {
            if (!inContext && sourceFrames >= config.frames) break;
            records.push({
              kind: inContext ? "context" : "frame",
              frame: Buffer.from(record.frame),
              offset: record.offset,
              ...(record.frameTimeMs === undefined ? {} : { timeMs: record.frameTimeMs }),
            });
            if (!inContext) sourceFrames++;
          }
        }
      } else if (fixture.gameId === "iracing") {
        let offset = 16;
        for (const frame of iracing.readIRacingFramesFromBuffer(bytes).slice(0, config.frames)) {
          records.push({ kind: "frame", frame: Buffer.from(frame), offset: offset + 5 });
          sourceFrames++;
          offset += frame.length + 5;
        }
      } else if (fixture.gameId === "lmu") {
        let offset = 16;
        for (const frame of lmu.readLMUFramesFromBuffer(bytes).slice(0, config.frames)) {
          records.push({ kind: "frame", frame: Buffer.from(frame), offset: offset + 5 });
          sourceFrames++;
          offset += frame.length + 5;
        }
      } else {
        let offset = 0;
        for (const frame of udp.readUdpDump(path, config.frames)) {
          records.push({ kind: "frame", frame, offset: offset + 4 });
          sourceFrames++;
          offset += frame.length + 4;
        }
      }
      if (!sourceFrames) {
        throw Error("Empty source-frame workload");
      }

      const game = registry.getServerGame(fixture.gameId);
      const sourceHash = hash(compressed);
      const workloadHash = hashWorkload(records);
      const contextRecords = records.filter((record) => record.kind === "context").length;
      const segmentRecords = records.filter((record) => record.kind === "segment").length;
      const copyRecords = (): RecordItem[] => records.map((record) => ({
        ...record,
        ...(record.frame ? { frame: Buffer.from(record.frame) } : {}),
      }));
      const prepareParse = (): ParseInput => ({
        records: copyRecords(),
        states: Array.from({ length: segmentRecords + 1 }, () => game.createParserState()),
      });

      // Capture full telemetry snapshots before another frame can advance a
      // stateful parser. These immutable source packets are never passed to a
      // pipeline; every measured/profiled invocation gets independent clones.
      const packets: TelemetryPacket[][] = [];
      let packetChunk: TelemetryPacket[] = [];
      {
        const prepared = prepareParse();
        let segment = 0;
        for (const record of prepared.records) {
          if (record.kind === "segment") {
            if (packetChunk.length) packets.push(packetChunk);
            packetChunk = [];
            segment++;
            continue;
          }
          const packet = game.tryParse(record.frame!, prepared.states[segment]);
          if (packet && record.kind === "frame") {
            packetChunk.push(structuredClone(packet));
            if (packetChunk.length === CHUNK_PACKETS) {
              packets.push(packetChunk);
              packetChunk = [];
            }
          }
        }
        if (packetChunk.length) packets.push(packetChunk);
      }
      const parsedCount = packets.reduce((count, part) => count + part.length, 0);
      if (!parsedCount) {
        throw Error("Bun parser accepted zero packets; increase --frames");
      }
      const makeChunks = (inputs: TelemetryPacket[][]): PipelineChunk[] => inputs.map((items) => ({
        items,
        pipeline: new pipelineModule.LiveTelemetryPipeline(
          new ports.NullDbAdapter(),
          new ports.NullWsAdapter(),
          {
            bypassPacketRateFilter: true,
            skipHistorySeeding: true,
            skipDevState: true,
            recorder: new ports.NullSessionRecorderAdapter(),
          },
        ),
      }));
      const clonePackets = (): TelemetryPacket[][] => packets.map((part) => structuredClone(part));
      const preparePipeline = (): PipelineChunk[] => makeChunks(clonePackets());
      let parseStats: MitataStatistics | undefined;
      let pipelineStats: MitataStatistics | undefined;
      const parseMemory: MemorySample[] = [];
      const pipelineMemory: MemorySample[] = [];

      if (memoryChild) {
        // Preserve the independent profiler's one warmup and three post-GC
        // windows. Never collect or report profiler elapsed times as throughput.
        const profileParse = (measured: boolean) => {
          const inputs = copyRecords();
          const retained = { state: null as unknown, output: undefined as unknown };
          const window = measured ? beginMemoryWindow(() => retained) : undefined;
          let state = game.createParserState();
          let output: TelemetryPacket | null | undefined;
          let count = 0;
          for (let index = 0; index < inputs.length; index++) {
            const record = inputs[index]!;
            if (record.kind === "segment") {
              state = game.createParserState();
              continue;
            }
            output = game.tryParse(record.frame!, state);
            if (output && record.kind === "frame") count++;
            if (window && index % CHUNK_PACKETS === 0) {
              retained.state = state;
              retained.output = output;
              window.sample();
            }
          }
          if (window) {
            retained.state = state;
            retained.output = output;
            window.sample();
            retained.output = undefined;
            output = undefined;
            parseMemory.push(window.finish());
          }
          if (count !== parsedCount) throw Error("Bun parse accepted count drift");
        };
        profileParse(false);
        for (let trial = 0; trial < MEMORY_TRIALS; trial++) profileParse(true);

        const profilePipeline = async (measured: boolean) => {
          const inputs = clonePackets();
          const retained: PipelineChunk[] = [];
          const window = measured ? beginMemoryWindow(() => retained) : undefined;
          const chunks = makeChunks(inputs);
          retained.push(...chunks);
          window?.sample();
          let processed = 0;
          for (const [index, item] of chunks.entries()) {
            const pipeline = item.pipeline!;
            for (const packet of item.items) {
              await pipeline.processPacket(packet);
              processed++;
              if (window && processed % CHUNK_PACKETS === 0) window.sample();
            }
            await pipeline.flushIncompleteLap();
            window?.sample();
            if (index !== chunks.length - 1) item.pipeline = undefined;
          }
          if (window) pipelineMemory.push(window.finish());
          if (processed !== parsedCount) throw Error("Bun processing count differs from parser");
          chunks.length = 0;
          retained.length = 0;
          inputs.length = 0;
        };
        await profilePipeline(false);
        for (let trial = 0; trial < MEMORY_TRIALS; trial++) await profilePipeline(true);
      } else {
        parseStats = await measure(function* () {
          yield {
            [0]: prepareParse,
            bench(input: ParseInput) {
              let segment = 0;
              let count = 0;
              for (const record of input.records) {
                if (record.kind === "segment") {
                  segment++;
                  continue;
                }
                const packet = game.tryParse(record.frame!, input.states[segment]);
                // Consume the complete returned packet, not a selected scalar.
                do_not_optimize(packet);
                if (packet && record.kind === "frame") count++;
              }
              if (count !== parsedCount) throw Error("Bun parse accepted count drift");
              return count;
            },
          };
        }, measurementOptions);
        pipelineStats = await measure(function* () {
          yield {
            [0]: preparePipeline,
            async bench(chunks: PipelineChunk[]) {
              let processed = 0;
              for (const [index, item] of chunks.entries()) {
                const pipeline = item.pipeline!;
                for (const packet of item.items) {
                  await pipeline.processPacket(packet);
                  processed++;
                }
                await pipeline.flushIncompleteLap();
                if (index !== chunks.length - 1) item.pipeline = undefined;
              }
              if (processed !== parsedCount) throw Error("Bun processing count differs from parser");
              do_not_optimize(processed);
              return processed;
            },
          };
        }, measurementOptions);
        for (const stats of [parseStats, pipelineStats]) {
          if (stats.kind !== "yield" || stats.samples.length !== config.trials ||
            !Number.isFinite(stats.p50) || stats.p50 <= 0 ||
            stats.samples.some((sample) => !Number.isFinite(sample) || sample <= 0)) {
            throw Error("Mitata returned invalid computed-stage statistics");
          }
        }
      }

      const gameReport: PipelineGame = {
        gameId: fixture.gameId,
        fixture: fixture.fixture,
        sourceHash,
        workloadHash,
        sourceFrames,
        records: records.length,
        contextRecords,
        segmentRecords,
        parse: stage(parseStats, "acceptedPackets", sourceFrames, parsedCount),
        pipeline: stage(pipelineStats, "processedPackets", sourceFrames, parsedCount),
        ...(memoryChild
          ? {
              memory: {
                method: "stage-code-memory-v4" as const,
                metric: "bun-post-gc-live-heap-bytes" as const,
                pid: process.pid,
                hostPid: process.pid,
                parse: summarize(parseMemory),
                pipeline: summarize(pipelineMemory),
                profileTrials: MEMORY_TRIALS,
                exclusions:
                  "Fixture loading, decoding, and prepared inputs excluded. Completed chunk state released; only final chunk state retained at stage end.",
                limitations: MEMORY_LIMITATIONS,
              },
            }
          : {}),
      };
      report.games.push(gameReport);
    } catch (error) {
      report.errors.push({
        gameId: fixture.gameId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config.memory === "on" && !memoryChild) {
    for (const game of report.games) {
      try {
        game.memory = await profileBunMemory({
          runner: import.meta.path,
          frames: config.frames,
          game,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        game.memory = { error: message };
        report.errors.push({ gameId: game.gameId, error: message });
      }
    }
  }
  if (!report.games.length || report.errors.length) process.exitCode = 1;
  await Bun.write(config.output, JSON.stringify(report, null, 2) + "\n");
  if (!memoryChild) {
    console.log = originalLog;
    console.warn = originalWarn;
    console.log(`Wrote ${config.output}`);
  }
} catch (error) {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error(error);
  process.exitCode = 1;
} finally {
  stopMaintenanceTasks?.();
  if (priorDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = priorDataDir;
  rmSync(isolatedDataDir, { recursive: true, force: true });
}
