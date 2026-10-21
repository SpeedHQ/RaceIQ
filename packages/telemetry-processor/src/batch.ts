import type { GameId } from "@raceiq/shared/games/ids";
import {
  processTelemetryBatch as processBatch,
  type TelemetryBatchInput,
  type TelemetryBatchOptions as CoreBatchOptions,
  type TelemetryBatchResult,
} from "@raceiq/telemetry-core/processor/batch";
import { getGameParser } from "./routing";

export type {
  TelemetryBatchBootstrap,
  TelemetryBatchFrame,
  TelemetryBatchInput,
  TelemetryBatchLap,
  TelemetryBatchResult,
  TelemetryBatchSession,
} from "@raceiq/telemetry-core/processor/batch";
export type TelemetryBatchOptions = Omit<CoreBatchOptions, "parser">;

/** Native parser composition root; batch lifecycle and policy live in telemetry-core. */
export function processTelemetryBatch(gameId: GameId, frames: readonly TelemetryBatchInput[], options: TelemetryBatchOptions = {}): Promise<TelemetryBatchResult> {
  return processBatch(gameId, frames, { ...options, parser: getGameParser(gameId) });
}
