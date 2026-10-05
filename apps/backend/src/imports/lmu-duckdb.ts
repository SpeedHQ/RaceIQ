import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import {
  importSessionFrames,
  type ImportedLap,
} from "@raceiq/backend-core/session-capture/import-pipeline";
import { importStagedWithRust } from "@raceiq/backend-core/session-capture/import-results";
import { getRecordingEngineKind } from "@raceiq/backend-core/runtime/recorder-engine";
import { readLMUDuckDBFrames } from "@raceiq/game-lmu/import-duckdb";

export async function importLMUDuckDB(
  path: string,
  ownership: SessionOwnership,
  stage?: { jobId: string; outputRoot: string; originalName: string; sidecarPath?: string },
): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  if (getRecordingEngineKind() === "rust") {
    if (!stage) throw new Error("Rust DuckDB imports require a staged original-file job");
    const result = await importStagedWithRust({
      path,
      sidecarPath: stage.sidecarPath,
      originalName: stage.originalName,
      outputRoot: stage.outputRoot,
      jobId: stage.jobId,
      gameId: "lmu",
      format: "duckdb",
      ownership,
      requireLaps: true,
    });
    return { packetCount: result.packetCount, laps: result.laps };
  }
  const frames = readLMUDuckDBFrames(path);
  const result = await importSessionFrames(frames, "lmu", {
    requireLaps: true,
    ownership,
  });
  return { packetCount: result.packetCount, laps: result.laps };
}
