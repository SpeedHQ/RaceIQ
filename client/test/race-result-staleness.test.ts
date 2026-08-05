import { describe, expect, test } from "bun:test";
import { useTelemetryStore } from "../src/stores/telemetry";

describe("race-result staleness state", () => {
  test("tracks notification and progress independently from lap reprocessing", () => {
    const store = useTelemetryStore.getState();
    store.setStaleRaceResults({ sessionCount: 3, currentVersion: "race-result-v2" });
    store.setRaceResultReprocessProgress({ done: 1, total: 3 });

    const state = useTelemetryStore.getState();
    expect(state.staleRaceResults).toEqual({ sessionCount: 3, currentVersion: "race-result-v2" });
    expect(state.raceResultReprocessProgress).toEqual({ done: 1, total: 3 });
    expect(state.reprocessProgress).toBeNull();
  });
});
