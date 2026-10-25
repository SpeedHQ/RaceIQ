import { describe, expect, test } from "bun:test";
import { deriveRaceResult } from "@raceiq/backend-core/race-results/derive";
import { extractRaceSource } from "@raceiq/backend-core/race-results/source";
import type { RaceSourceObservation } from "@raceiq/backend-core/race-results/types";
import type { RaceResultProvenance } from "@raceiq/shared/racing/results/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

const provenance: RaceResultProvenance = {
  catalogVersion: "test", catalogHash: "sha256:test", catalogSchemaVersion: "test",
  parserVersion: "test", resolverVersion: "test", derivationId: "race-result-derivation",
  derivationVersion: "3", derivationCodeHash: "sha256:test", rawInput: null,
  authorityPolicyId: "race-result-outcome-authority", authorityPolicyVersion: "1",
};
const source = (overrides: Partial<RaceSourceObservation> = {}): RaceSourceObservation => ({
  gameId: "lmu", provenance,
  evidence: { fieldStatus: { sessionType: "unavailable", classification: "unavailable", finishingPosition: "unavailable", qualifyingPosition: "unavailable", isPodium: "unavailable", isFastestLap: "unavailable", pitEvents: "unavailable", tyreStrategy: "unavailable", fuelStrategy: "unavailable" }, conflicts: [] },
  reasons: [], ...overrides,
});
const packet = (overrides: Partial<TelemetryPacket> = {}): TelemetryPacket => ({
  gameId: "lmu", IsRaceOn: 1, TimestampMS: 1, CurrentRaceTime: 10,
  LapNumber: 4, RacePosition: 2, BestLap: 90, ...overrides,
} as TelemetryPacket);

describe("LMU race result derivation", () => {
  test("practice has no race positions or position changes", () => {
    const result = deriveRaceResult(source({
      sessionType: "practice-1", finishingPosition: 2, qualifyingPosition: 3,
      positionChanges: [{ eventType: "position-change", sequence: 1, lapNumber: 2, elapsedSeconds: 90,
        durationSeconds: null, service: "unknown", tyreChange: null, fuelAdded: null,
        fuelBefore: null, fuelAfter: null, linkage: "linked", source: {}, positionBefore: 3, positionAfter: 2 }],
    }));
    expect(result.classification).toBe("unknown");
    expect(result.finishingPosition).toBeNull();
    expect(result.qualifyingPosition).toBeNull();
    expect(result.isPodium).toBeNull();
    expect(result.events).toEqual([]);
    expect(result.evidence.fieldStatus.finishingPosition).toBe("unavailable");
    expect(result.evidence.fieldStatus.qualifyingPosition).toBe("unavailable");
  });
  test("test day is practice, not a classified race", () => {
    const result = deriveRaceResult(source({ sessionType: "test-day", finishingPosition: 1 }));
    expect(result.sessionType).toBe("practice");
    expect(result.finishingPosition).toBeNull();
    expect(result.isPodium).toBeNull();
  });
});

describe("LMU race result source extraction", () => {
  test("uses session mode to distinguish practice timing rank from race position", () => {
    for (const sessionType of ["practice-1", "test-day", "race"]) {
      const resultSource = extractRaceSource("lmu", [
        packet({ LapNumber: 1, RacePosition: 3, lmu: { sessionType, inPits: false } as never }),
        packet({ LapNumber: 2, RacePosition: 2, lmu: { sessionType, inPits: false } as never }),
      ]);
      expect(resultSource.sessionType).toBe(sessionType);
      expect(resultSource.provenance.fields?.sessionType).toBe("lmu.sessionType");
      const result = deriveRaceResult(resultSource);
      if (sessionType === "race") {
        expect(result.finishingPosition).toBe(2);
        expect(result.events).toMatchObject([{ eventType: "position-change", positionBefore: 3, positionAfter: 2 }]);
      } else {
        expect(result.finishingPosition).toBeNull();
        expect(result.events).toEqual([]);
      }
    }
  });
});
