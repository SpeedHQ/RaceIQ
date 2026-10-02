/** Test-only counters for parser work. Production callers pay only four integer increments when enabled. */
export interface ParserInstrumentation {
  sourceFramesScanned: number;
  parserStatePrimes: number;
  indexSamplesMaterialized: number;
  fullPacketsMaterialized: number;
}

let enabled = false;
let counters: ParserInstrumentation = empty();

function empty(): ParserInstrumentation {
  return { sourceFramesScanned: 0, parserStatePrimes: 0, indexSamplesMaterialized: 0, fullPacketsMaterialized: 0 };
}

export function enableParserInstrumentation(value = true): void { enabled = value; }
export function resetParserInstrumentation(): void { counters = empty(); }
export function getParserInstrumentation(): ParserInstrumentation { return { ...counters }; }
export function countSourceFrameScanned(): void { if (enabled) counters.sourceFramesScanned++; }
export function countParserStatePrime(): void { if (enabled) counters.parserStatePrimes++; }
export function countIndexSampleMaterialized(): void { if (enabled) counters.indexSamplesMaterialized++; }
export function countFullPacketMaterialized(): void { if (enabled) counters.fullPacketsMaterialized++; }
