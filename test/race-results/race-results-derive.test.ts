import { describe, expect, test } from "bun:test";
import { deriveRaceResult, normalizeSessionType } from "../../server/race-results/derive";
import type { RaceSourceObservation } from "../../server/race-results/types";
import type { RaceEvent, RaceEventId } from "../../shared/racing/events/contracts";
import type { RaceResultProvenance } from "../../shared/racing/results/types";
const provenance: RaceResultProvenance = {
  catalogVersion: "test",
  catalogHash: "sha256:test",
  catalogSchemaVersion: "test",
  parserVersion: "test",
  resolverVersion: "test",
  derivationId: "race-result-derivation",
  derivationVersion: "3",
  derivationCodeHash: "sha256:test",
  rawInput: null,
  canonicalInput: null,
  authorityPolicyId: "race-result-outcome-authority",
  authorityPolicyVersion: "1",
};

const source = (overrides: Partial<RaceSourceObservation> = {}): RaceSourceObservation => ({
  gameId: "f1-2025",
  provenance,
  evidence: {
    fieldStatus: {
      sessionType: "unavailable",
      classification: "unavailable",
      finishingPosition: "unavailable",
      qualifyingPosition: "unavailable",
      isPodium: "unavailable",
      isFastestLap: "unavailable",
      pitTimeline: "unavailable",
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
    expect(deriveRaceResult(source({ sessionType: "race", classification: "finished", finishingPosition: 1 })).outcomeStatus).toBe("provisional");
  });

  test("does not classify practice positions as race finishes", () => {
    expect(deriveRaceResult(source({ sessionType: "practice", finishingPosition: 2 })).classification).toBe("unknown");
  });

  test("does not infer outcome from missing fields", () => {
    const result = deriveRaceResult(source({ sessionType: "race" }));
    expect(result.classification).toBe("unknown");
    expect(result.finishingPosition).toBeNull();
    expect(result.isPodium).toBeNull();
    expect(result.isFastestLap).toBeNull();
    expect(result.reasons).toContain("finishing-position-unknown");
    expect(result.outcomeStatus).toBe("unavailable");
  });

  test("keeps qualifying distinct from race classification", () => {
    expect(deriveRaceResult(source({ sessionType: "qualifying", finishingPosition: 2 })).classification).toBe("qualifying");
  });

  test("retains confirmed outcome for direct conflict-free classification", () => {
    const baseEvidence = source().evidence;
    expect(
      deriveRaceResult(
        source({
          sessionType: "race",
          classification: "finished",
          finishingPosition: 2,
          evidence: {
            ...baseEvidence,
            fieldStatus: { ...baseEvidence.fieldStatus, classification: "direct" },
          },
        }),
      ).outcomeStatus,
    ).toBe("confirmed");
  });
});

describe("pit timeline projection", () => {
  test("counts visits and projects observed service evidence", () => {
    const id = (suffix: string) => `race-event:sha256:${suffix.repeat(64).slice(0, 64)}` as RaceEventId;
    const events = [
      { eventId: id("a"), eventType: "pit_entry", lifecycleId: "visit:1", participantKind: "player", payload: { previousState: "out", state: "pit-lane" } },
      { eventId: id("b"), eventType: "fuel_service_observed", lifecycleId: "visit:1", participantKind: "player", lapNumber: 4, payload: { beforeLitres: 20, afterLitres: 30, addedLitres: 10 } },
      {
        eventId: id("c"),
        eventType: "tire_service_observed",
        lifecycleId: "visit:1",
        participantKind: "player",
        lapNumber: 4,
        payload: { changedCorners: ["fl"], previousCompound: "soft", currentCompound: "medium", beforeWear: null, afterWear: null },
      },
    ] as RaceEvent[];
    const result = deriveRaceResult(source({ sessionType: "race" }), events);
    expect(result.pitCount).toBe(1);
    expect(result.eventIds).toEqual(events.map(({ eventId }) => eventId));
    expect(result.fuelStrategy).toMatchObject({ services: [{ addedLitres: 10 }] });
    expect(result.tyreStrategy).toMatchObject({ services: [{ currentCompound: "medium" }] });
    expect(result.evidence.fieldStatus.pitTimeline).toBe("derived");
  });
});
