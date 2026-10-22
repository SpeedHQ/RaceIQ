import { registerRaceStrategyRuntime } from "@raceiq/backend-core/telemetry/race-strategy-ports";
import { PitTracker } from "./pit-tracker";
import { DurableStrategyTracker } from "./durable-strategy";
import { StrategyRebuild } from "./strategy-rebuild";
import { clearPitEstimates, publishStrategyChanges } from "./strategy-queries";
import { needsStrategyBackfill } from "./strategy-backfill";

/** Application composition registers the same feature implementation in main and worker runtimes. */
export function registerRaceStrategyFeature(): void {
  registerRaceStrategyRuntime({
    createPitTracker: () => new PitTracker(),
    createLiveTracker: (notify) => new DurableStrategyTracker(notify),
    createRebuild: (sessionId, driverKey, fallbackTime) => new StrategyRebuild(sessionId, driverKey, fallbackTime),
    needsBackfill: needsStrategyBackfill,
    clearEstimates: clearPitEstimates,
    publishHistory: publishStrategyChanges,
  });
}
