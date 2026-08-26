import { describe, expect, test } from "bun:test";
import { telemetryStore, useTelemetryStore } from "../src/stores/telemetry";

describe("race-result staleness state", () => {
  test("tracks notification and progress independently from lap reprocessing", () => {
    const store = telemetryStore.get();
    telemetryStore.actions.setStaleRaceResults({ sessionCount: 3, currentVersion: "race-result-v2" });
    telemetryStore.actions.setRaceResultReprocessProgress({ done: 1, total: 3 });

    const state = telemetryStore.get();
    expect(state.staleRaceResults).toEqual({ sessionCount: 3, currentVersion: "race-result-v2" });
    expect(state.raceResultReprocessProgress).toEqual({ done: 1, total: 3 });
    expect(state.reprocessProgress).toBeNull();
  });
});
