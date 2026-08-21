import { describe, expect, test } from "bun:test";

import {
  RACE_EVENT_SCHEMA_VERSION,
  RaceEventDraftSchema,
  RaceEventPageSchema,
  RaceEventQuerySchema,
  RaceEventSchema,
  RaceEventsAppendedMessageSchema,
  RaceEventsReplacedMessageSchema,
} from "../../shared/racing/events/contracts";

const eventId = `race-event:sha256:${"a".repeat(64)}`;

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId,
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
  };
}

describe("race event contracts", () => {
  test("validates a complete persisted event and its transport DTOs", () => {
    const parsed = RaceEventSchema.parse(event());
    expect(parsed.eventType).toBe("pit_entry");
    expect(RaceEventPageSchema.parse({ items: [parsed], nextCursor: null, tailCursor: "tail" }).items)
      .toHaveLength(1);
    expect(
      RaceEventsAppendedMessageSchema.parse({
        type: "race-events-appended",
        sessionId: 12,
        events: [parsed],
      }).events,
    ).toHaveLength(1);
    expect(
      RaceEventsReplacedMessageSchema.parse({
        type: "race-events-replaced",
        sessionId: 12,
      }).sessionId,
    ).toBe(12);
  });

  test("uses the event type to enforce a strict payload", () => {
    expect(
      RaceEventSchema.safeParse(
        event({ payload: { previousState: "out", state: "pit-lane", text: "pit" } }),
      ).success,
    ).toBe(false);
    expect(
      RaceEventSchema.safeParse(
        event({ eventType: "fuel_service_observed" }),
      ).success,
    ).toBe(false);
  });

  test("validates drafts without persistence-generated identity fields", () => {
    const draft = event();
    Reflect.deleteProperty(draft, "eventId");
    Reflect.deleteProperty(draft, "contentHash");
    Reflect.deleteProperty(draft, "createdAt");
    expect(RaceEventDraftSchema.safeParse(draft).success).toBe(true);
  });

  test("validates intersecting query filters and cursor limits", () => {
    const query = RaceEventQuerySchema.parse({
      gameId: "acc",
      participantId: "local-player",
      lapNumber: "4",
      fromSourceTimeMs: "1000",
      toSourceTimeMs: "2000",
      qualityOnly: "false",
      limit: "1000",
    });
    expect(query).toMatchObject({
      lapNumber: 4,
      qualityOnly: false,
      limit: 1000,
    });
    expect(RaceEventQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
    expect(RaceEventQuerySchema.safeParse({ limit: 200 }).success).toBe(false);
    expect(
      RaceEventQuerySchema.safeParse({
        fromSourceTimeMs: 2,
        toSourceTimeMs: 1,
      }).success,
    ).toBe(false);
  });
});
