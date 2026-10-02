import type { AccSharedMemoryReader } from "@raceiq/game-acc/shared-memory";
import type { AcEvoSharedMemoryReader } from "@raceiq/game-ac-evo/shared-memory";
import type { IRacingTelemetrySource } from "@raceiq/game-iracing/source";
import type { LMUTelemetrySource } from "@raceiq/game-lmu/source";

let accReader: AccSharedMemoryReader | null = null;
let acEvoReader: AcEvoSharedMemoryReader | null = null;
let iracingSource: IRacingTelemetrySource | null = null;
let lmuSource: LMUTelemetrySource | null = null;

export function setAccReader(reader: AccSharedMemoryReader | null): void {
  accReader = reader;
}

export function setAcEvoReader(reader: AcEvoSharedMemoryReader | null): void {
  acEvoReader = reader;
}

export function setIracingSource(reader: IRacingTelemetrySource | null): void {
  iracingSource = reader;
}
export function setLmuSource(source: LMUTelemetrySource | null): void {
  lmuSource = source;
}


export function getAccReader(): AccSharedMemoryReader | null {
  return accReader;
}

export function getAcEvoReader(): AcEvoSharedMemoryReader | null {
  return acEvoReader;
}

export function getIracingSource(): IRacingTelemetrySource | null {
  return iracingSource;
}

export function getLmuSource(): LMUTelemetrySource | null {
  return lmuSource;
}

