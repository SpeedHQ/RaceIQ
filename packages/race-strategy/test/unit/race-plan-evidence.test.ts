import { describe, expect, test } from "bun:test";
import type { StintSummary } from "@raceiq/shared/racing/live/strategy";
import { aggregateRacePlanEvidence, classifyRacePlanWeather } from "@raceiq/shared/racing/live/race-plan-evidence";

function evidence(id: number, fuel: number, laps: number, weather: string | null, setupKey = "setup"): StintSummary {
  const rate = (value: number, eligibleLaps: number) => ({ value, unit: "wearFraction/lap" as const, eligibleLaps, source: "history" as const, provisional: false, unavailableReason: null });
  return {
    id: `stint-${id}`, sessionId: id, driverKey: "local-player", ordinal: 1, status: "completed", gameId: "fm-2023", trackId: "track", carId: "car", pi: 800,
    compounds: ["soft", "soft", "soft", "soft"], compatibility: { fuelSemanticVersion: "fuel-v1", tireSemanticVersions: ["tire-v1", "tire-v1", "tire-v1", "tire-v1"], setupKey,
      conditions: { weather, airTemperatureC: 20, trackTemperatureC: 25 } }, startedAt: "2025-01-01T00:00:00.000Z", endedAt: "2025-01-01T00:10:00.000Z",
    firstLapNumber: 1, lastLapNumber: laps, boundary: { reason: "pit", confidence: "observed" }, completedLaps: laps,
    fuel: { value: fuel, unit: "L/lap", eligibleLaps: laps, source: "history", provisional: false, unavailableReason: null },
    tires: [0, 1, 2, 3].map(() => rate(0.01, laps)) as StintSummary["tires"], measuredFuelUsed: fuel * laps, fuelUnit: "L", fuelCoverage: "complete",
    averageLapSeconds: 90, paceLaps: laps, exclusions: [], algorithmVersion: "test", revision: 1,
  };
}

describe("race-plan aggregate evidence", () => {
  test("weights each eligible metric lap, separates weather and compatibility, and bounds provenance", () => {
    const dryA = evidence(1, 0.02, 2, "dry");
    const dryB = evidence(2, 0.04, 6, "dry");
    const mismatch = evidence(3, 1, 20, "wet");
    const setupMismatch = evidence(4, 4, 20, "dry", "other");
    const baseline = aggregateRacePlanEvidence([dryA, dryB, mismatch, setupMismatch], "dry");
    expect(baseline?.fuel.value).toBeCloseTo(0.035);
    expect(baseline?.fuel.eligibleLaps).toBe(8);
    expect(baseline?.sources.map((source) => source.id)).toEqual(["stint-1", "stint-2"]);
    expect(aggregateRacePlanEvidence([dryA, mismatch], "wet")?.fuel.value).toBe(1);
    expect(aggregateRacePlanEvidence([dryA], "wet")).toBeNull();
    expect(aggregateRacePlanEvidence(Array.from({ length: 101 }, (_, index) => evidence(index, 0.02, 1, "dry")), "any")?.sources).toHaveLength(100);
  });

  test("classifies only explicit recognized weather; unknown remains unknown", () => {
    expect(classifyRacePlanWeather("2")).toBe("dry");
    expect(classifyRacePlanWeather("5")).toBe("wet");
    expect(classifyRacePlanWeather(null)).toBe("unknown");
    expect(aggregateRacePlanEvidence([evidence(1, 0.02, 2, null)], "any")?.weather).toBe("unknown");
  });
});
