import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import {
  importSessionFrames,
  type ImportedLap,
} from "@raceiq/backend-core/session-capture/import-pipeline";
import { readLMUDuckDBFrames } from "@raceiq/game-lmu/import-duckdb";

export async function importLMUDuckDB(
  path: string,
  ownership: SessionOwnership,
): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  const frames = readLMUDuckDBFrames(path);
  const result = await importSessionFrames(frames, "lmu", {
    requireLaps: true,
    ownership,
  });
  return { packetCount: result.packetCount, laps: result.laps };
}
