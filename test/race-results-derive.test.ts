import { describe, expect, test } from "bun:test";
import { deriveRaceResult, normalizeSessionType } from "../server/race-results/derive";
import { classifyPitService, derivePitLedger } from "../server/race-results/pit-ledger";
import type { RaceSourceObservation } from "../server/race-results/types";

const source = (overrides: Partial<RaceSourceObservation> = {}): RaceSourceObservation => ({
  gameId: "f1-2025",
  packets: [],
  provenance: {},
  evidence: {
    fieldStatus: {
      sessionType: "unavailable",
      classification: "unavailable",
      finishingPosition: "unavailable",
      qualifyingPosition: "unavailable",
      isPodium: "unavailable",
      isFastestLap: "unavailable",
      pitEvents: "unavailable",
      tyreStrategy: "unavailable",
      fuelStrategy: "unavailable",
    },
    conflicts: [],
  },
  reasons: [],
  ...overrides,
});

describe("race result derivation", () => {
  test("normalizes session families", () => {
    expect(normalizeSessionType("race-2")).toBe("race");
    expect(normalizeSessionType("qualifying-1")).toBe("qualifying");
    expect(normalizeSessionType(undefined)).toBe("unknown");
  });

  test("derives finished podium boundaries", () => {
    expect(deriveRaceResult(source({ sessionType: "race", classification: "finished", finishingPosition: 1 })).isPodium).toBe(true);
    expect(deriveRaceResult(source({ sessionType: "race", classification: "finished", finishingPosition: 3 })).isPodium).toBe(true);
    expect(deriveRaceResult(source({ sessionType: "race", classification: "finished", finishingPosition: 4 })).isPodium).toBe(false);
  });

  test("does not infer outcome from missing fields", () => {
    const result = deriveRaceResult(source({ sessionType: "race" }));
    expect(result.classification).toBe("unknown");
    expect(result.finishingPosition).toBeNull();
    expect(result.isPodium).toBeNull();
    expect(result.isFastestLap).toBeNull();
    expect(result.reasons).toContain("finishing-position-unknown");
  });

  test("keeps qualifying distinct from race classification", () => {
    expect(deriveRaceResult(source({ sessionType: "qualifying", finishingPosition: 2 })).classification).toBe("qualifying");
  });
});

describe("pit ledger", () => {
  test("classifies independent tyre and fuel signals", () => {
    expect(classifyPitService({ tyreChange: { from: "soft", to: "medium" } })).toBe("tyres");
    expect(classifyPitService({ fuelAdded: 12 })).toBe("fuel");
    expect(classifyPitService({ tyreChange: {}, fuelAdded: 12 })).toBe("combined");
    expect(classifyPitService({})).toBe("unknown");
  });

  test("sorts and renumbers events without deriving missing services", () => {
    const events = derivePitLedger([
      { sequence: 8, lapNumber: 12, fuelAdded: 10 },
      { sequence: 2, lapNumber: 4 },
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.service)).toEqual(["unknown", "fuel"]);
  });
});
