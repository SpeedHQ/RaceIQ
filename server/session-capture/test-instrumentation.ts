import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Test-only counters for parser and LMU opponent-index work. */
export interface ParserInstrumentation {
  sourceFramesScanned: number;
  parserStatePrimes: number;
  indexSamplesMaterialized: number;
  fullPacketsMaterialized: number;
}

export interface LmuOpponentIndexInstrumentation extends ParserInstrumentation {
  playerPacketsDecoded: number;
  blocksWritten: number;
  bytesWritten: number;
  framesWritten: number;
  blocksRead: number;
  bytesRead: number;
  framesDecoded: number;
  buildDurationMs: number;
  processCpuUserMicros: number;
  processCpuSystemMicros: number;
  peakProcessRssBytes: number;
}

const metricsFile = process.env.RACEIQ_LMU_OPPONENT_INDEX_TEST_METRICS_FILE ?? null;
let enabled = metricsFile !== null;
let counters: ParserInstrumentation = empty();
let indexCounters = emptyIndexCounters();
let metricsWrite = Promise.resolve();
let metricsWriteFailure: unknown;

function empty(): ParserInstrumentation {
  return { sourceFramesScanned: 0, parserStatePrimes: 0, indexSamplesMaterialized: 0, fullPacketsMaterialized: 0 };
}

type IndexCounters = Pick<LmuOpponentIndexInstrumentation,
  "sourceFramesScanned" | "blocksWritten" | "bytesWritten" | "framesWritten" |
  "blocksRead" | "bytesRead" | "framesDecoded" | "buildDurationMs" |
  "processCpuUserMicros" | "processCpuSystemMicros" | "peakProcessRssBytes">;

function emptyIndexCounters(): IndexCounters {
  return {
    sourceFramesScanned: 0, blocksWritten: 0, bytesWritten: 0, framesWritten: 0,
    blocksRead: 0, bytesRead: 0, framesDecoded: 0, buildDurationMs: 0,
    processCpuUserMicros: 0, processCpuSystemMicros: 0, peakProcessRssBytes: 0,
  };
}

function snapshot(): LmuOpponentIndexInstrumentation {
  const parser = getParserInstrumentation();
  return {
    ...parser,
    ...indexCounters,
    sourceFramesScanned: parser.sourceFramesScanned + indexCounters.sourceFramesScanned,
    playerPacketsDecoded: parser.fullPacketsMaterialized,
  };
}

function persistMetrics(): void {
  if (!metricsFile) return;
  const content = JSON.stringify(snapshot());
  const temporary = `${metricsFile}.${process.pid}.tmp`;
  metricsWrite = metricsWrite.then(async () => {
    await mkdir(dirname(metricsFile), { recursive: true });
    await writeFile(temporary, content);
    await rename(temporary, metricsFile);
  }).catch((error) => { metricsWriteFailure = error; });
}

export function enableParserInstrumentation(value = true): void {
  enabled = value || metricsFile !== null;
  if (enabled) persistMetrics();
}
export function resetParserInstrumentation(): void {
  counters = empty();
  persistMetrics();
}
export function getParserInstrumentation(): ParserInstrumentation { return { ...counters }; }
export function countSourceFrameScanned(): void { if (enabled) counters.sourceFramesScanned++; }
export function countParserStatePrime(): void { if (enabled) counters.parserStatePrimes++; }
export function countIndexSampleMaterialized(): void { if (enabled) counters.indexSamplesMaterialized++; }
export function countFullPacketMaterialized(): void { if (enabled) counters.fullPacketsMaterialized++; }

export function enableLmuOpponentIndexInstrumentation(value = true): void {
  enabled = value || metricsFile !== null;
  if (enabled) persistMetrics();
}
export function resetLmuOpponentIndexInstrumentation(): void {
  counters = empty();
  indexCounters = emptyIndexCounters();
  metricsWriteFailure = undefined;
  persistMetrics();
}
export function isLmuOpponentIndexInstrumentationEnabled(): boolean { return enabled; }
export function getLmuOpponentIndexInstrumentation(): LmuOpponentIndexInstrumentation { return snapshot(); }
export function recordLmuOpponentIndexMetrics(
  metrics: Partial<LmuOpponentIndexInstrumentation>,
): void {
  if (!enabled) return;
  if (metrics.sourceFramesScanned !== undefined) indexCounters.sourceFramesScanned += metrics.sourceFramesScanned;
  if (metrics.blocksWritten !== undefined) indexCounters.blocksWritten += metrics.blocksWritten;
  if (metrics.bytesWritten !== undefined) indexCounters.bytesWritten += metrics.bytesWritten;
  if (metrics.framesWritten !== undefined) indexCounters.framesWritten += metrics.framesWritten;
  if (metrics.blocksRead !== undefined) indexCounters.blocksRead += metrics.blocksRead;
  if (metrics.bytesRead !== undefined) indexCounters.bytesRead += metrics.bytesRead;
  if (metrics.framesDecoded !== undefined) indexCounters.framesDecoded += metrics.framesDecoded;
  if (metrics.buildDurationMs !== undefined) indexCounters.buildDurationMs += metrics.buildDurationMs;
  if (metrics.processCpuUserMicros !== undefined) indexCounters.processCpuUserMicros += metrics.processCpuUserMicros;
  if (metrics.processCpuSystemMicros !== undefined) indexCounters.processCpuSystemMicros += metrics.processCpuSystemMicros;
  if (metrics.peakProcessRssBytes !== undefined) indexCounters.peakProcessRssBytes = Math.max(indexCounters.peakProcessRssBytes, metrics.peakProcessRssBytes);
  persistMetrics();
}
export async function flushLmuOpponentIndexInstrumentation(): Promise<void> {
  await metricsWrite;
  if (metricsWriteFailure) throw metricsWriteFailure;
}
