import { describe, expect, test } from "bun:test";

import { RACE_EVENT_SCHEMA_VERSION, RaceEventSchema, RaceEventTypeSchema, type RaceEvent } from "../../shared/racing/events/contracts";
import { RACE_EVENT_LABELS, flattenRaceEventPages, formatRaceEventDetails, raceEventBadges } from "../src/components/race-events/RaceEventTimeline";

function event(overrides: Record<string, unknown> = {}): RaceEvent {
  return RaceEventSchema.parse({
    eventId: `race-event:sha256:${"a".repeat(64)}`,
    eventType: "pit_entry",
    schemaVersion: RACE_EVENT_SCHEMA_VERSION,
    sessionId: 12,
    participantId: "local-player",
    participantKind: "player",
    driverId: null,
    teamId: null,
    timelineEpoch: 0,
    sequence: 8,
    eventOrder: 50,
    sourceTimeMs: 2_000,
    sourceEndTimeMs: 2_000,
    sourceSequenceFamily: "iracing-session-tick",
    sourceSequence: 100,
    receivedAtMs: 2_010,
    lapNumber: 4,
    lapId: null,
    trackDistanceM: 1_200,
    trackDistancePct: 0.4,
    worldPosition: null,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
    sourceKind: "native-live",
    payload: { previousState: "out", state: "pit-lane" },
    lifecycleId: "pit-visit:12:1",
    linkedEventId: null,
    detectorId: "pit-service",
    detectorVersion: "1",
    sourceGeneration: null,
    analysisGenerationId: null,
    contentHash: `sha256:${"b".repeat(64)}`,
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  });
}

describe("race event timeline", () => {
  test("defines a factual label for every contract event type", () => {
    expect(Object.keys(RACE_EVENT_LABELS).sort()).toEqual([...RaceEventTypeSchema.options].sort());
    expect(RACE_EVENT_LABELS.caution_started).toBe("Caution started");
    expect(RACE_EVENT_LABELS.pit_entry).toBe("Entered pit road");
    expect(RACE_EVENT_LABELS.fuel_service_observed).toBe("Fuel service observed");
    expect(RACE_EVENT_LABELS.pit_exit).toBe("Exited pit road");
  });

  test("formats factual payload values with their evidence units", () => {
    const details = formatRaceEventDetails(
      event({
        eventType: "fuel_service_observed",
        payload: { beforeLitres: 20.25, afterLitres: 27.75, addedLitres: 7.5 },
      }),
    );

    expect(details).toContain("Fuel before service: 20.25 L");
    expect(details).toContain("Fuel after service: 27.75 L");
    expect(details).toContain("Fuel added: 7.5 L");
  });

  test("keeps evidence and quality badges separate", () => {
    expect(raceEventBadges(event())).toEqual({ evidence: "Observed", quality: null });
    expect(raceEventBadges(event({ evidenceKind: "derived" }))).toEqual({ evidence: "Derived", quality: null });
    expect(raceEventBadges(event({ evidenceKind: "inferred", qualityState: "ambiguous" }))).toEqual({
      evidence: "Inferred",
      quality: "Ambiguous",
    });
    expect(raceEventBadges(event({ qualityState: "unavailable" }))).toEqual({ evidence: "Observed", quality: "Unavailable" });
  });

  test("omits null payload fields", () => {
    const details = formatRaceEventDetails(
      event({
        eventType: "participant_joined",
        payload: {
          sourceId: "car-1",
          identityState: "session-scoped",
          displayName: null,
          vehicleId: null,
        },
      }),
    );

    expect(details).toContain("Source participant ID: car-1");
    expect(details.some((detail) => detail.startsWith("Display name:"))).toBe(false);
    expect(details.some((detail) => detail.startsWith("Vehicle ID:"))).toBe(false);
  });

  test("flattens paginated results in canonical chronological order", () => {
    const later = event({
      eventId: `race-event:sha256:${"c".repeat(64)}`,
      sequence: 9,
    });
    const earlier = event({
      eventId: `race-event:sha256:${"d".repeat(64)}`,
      sequence: 7,
    });

    expect(
      flattenRaceEventPages([
        { items: [later], nextCursor: "page-two" },
        { items: [earlier], nextCursor: null },
      ]).map((item) => item.eventId),
    ).toEqual([earlier.eventId, later.eventId]);
  });
});
