import type { AccSharedMemoryReader } from "../games/acc/shared-memory";
import type { AcEvoSharedMemoryReader } from "../games/ac-evo/shared-memory";
import type { IRacingTelemetrySource } from "../games/iracing/source";

let accReader: AccSharedMemoryReader | null = null;
let acEvoReader: AcEvoSharedMemoryReader | null = null;
let iracingSource: IRacingTelemetrySource | null = null;

export function setAccReader(reader: AccSharedMemoryReader | null): void {
  accReader = reader;
}

export function setAcEvoReader(reader: AcEvoSharedMemoryReader | null): void {
  acEvoReader = reader;
}

export function setIracingSource(reader: IRacingTelemetrySource | null): void {
  iracingSource = reader;
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

