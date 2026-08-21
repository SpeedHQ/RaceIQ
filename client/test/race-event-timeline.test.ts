import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RACE_EVENT_SCHEMA_VERSION, RaceEventSchema, RaceEventTypeSchema, type RaceEvent } from "../../shared/racing/events/contracts";
import { RaceEventTimeline, RACE_EVENT_LABELS, flattenRaceEventPages, formatRaceEventDetails, raceEventBadges } from "../src/components/race-events/RaceEventTimeline";
import { mergeAppendedRaceEvents, recoverRaceEventTail } from "../src/lib/race-event-cache";
import { queryClient } from "../src/lib/queryClient";
import { mergeAppendedRaceEventsIntoCaches, resetRaceEventCaches } from "../src/hooks/useWebSocket";
import { queryKeys } from "../src/hooks/query-keys";
import { getLocale, overwriteGetLocale, type Locale } from "../src/paraglide/runtime";

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

function renderTimeline(locale: Locale, pages: Array<{ items: RaceEvent[]; nextCursor: string | null; tailCursor: string | null }>): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.sessionEvents(12, "acc"), { pages, pageParams: [undefined] });
  const previousLocale = getLocale();
  overwriteGetLocale(() => locale);
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(RaceEventTimeline, { sessionId: 12, gameId: "acc", enabled: true }),
      ),
    );
  } finally {
    overwriteGetLocale(() => previousLocale);
    client.clear();
  }
}

describe("race event timeline", () => {
  test("defines a factual label for every contract event type", () => {
    expect(Object.keys(RACE_EVENT_LABELS).sort()).toEqual([...RaceEventTypeSchema.options].sort());
    expect(RACE_EVENT_LABELS.caution_started()).toBe("Caution started");
    expect(RACE_EVENT_LABELS.pit_entry()).toBe("Entered pit road");
    expect(RACE_EVENT_LABELS.fuel_service_observed()).toBe("Fuel service observed");
    expect(RACE_EVENT_LABELS.pit_exit()).toBe("Exited pit road");
  });


  test("renders German event labels, quality states, payload labels, and assistive text", () => {
    const markup = renderTimeline("de", [
      {
        items: [event({ evidenceKind: "derived", qualityState: "ambiguous" })],
        nextCursor: null,
        tailCursor: "tail-1",
      },
    ]);
    expect(markup).toContain("Boxengasse befahren");
    expect(markup).toContain("Abgeleitet");
    expect(markup).toContain("Mehrdeutig");
    expect(markup).toContain("Vorheriger Boxenstatus");
    expect(markup).toContain('aria-label="Rennereignis-Zeitlinie"');
    expect(markup).toContain('aria-label="Diagnose für Boxengasse befahren umschalten"');
    expect(markup).not.toContain("Entered pit road");

    const emptyMarkup = renderTimeline("de", [{ items: [], nextCursor: null, tailCursor: null }]);
    expect(emptyMarkup).toContain("Keine Rennereignisse aufgezeichnet.");
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

  test("preserves free text while humanizing known hyphenated and underscored enums", () => {
    const freeText = formatRaceEventDetails(
      event({
        eventType: "session_phase_changed",
        payload: {
          phase: "green",
          previousPhase: "caution",
          reason: "driver said pit-lane_here",
          nativeCode: null,
        },
      }),
    );
    const enums = formatRaceEventDetails(
      event({
        eventType: "lap_completed",
        payload: {
          lapNumber: 4,
          lapTimeMs: null,
          isValid: true,
          phase: "grid_start",
          conditions: ["slow_zone"],
        },
      }),
    );

    expect(freeText).toContain("Reason: driver said pit-lane_here");
    expect(enums).toContain("Phase: Grid start");
    expect(enums).toContain("Conditions: Slow zone");
  });

  test("merges append messages beyond a loaded 200-event prefix and recovers durable tail after reconnect", async () => {
    const oldestPage = {
      items: Array.from({ length: 200 }, (_, index) =>
        event({
          eventId: `race-event:sha256:${(index + 1).toString(16).padStart(64, "0")}`,
          sequence: index + 1,
        }),
      ),
      nextCursor: "after-200",
      tailCursor: "tail-200",
    };
    const appended = event({
      eventId: `race-event:sha256:${"e".repeat(64)}`,
      sequence: 201,
    });
    const initial = { pages: [oldestPage], pageParams: [undefined] };

    const merged = mergeAppendedRaceEvents(initial, [appended]);
    expect(flattenRaceEventPages(merged.pages)).toHaveLength(201);
    expect(flattenRaceEventPages(merged.pages).at(-1)?.eventId).toBe(appended.eventId);

    const matchingKey = queryKeys.sessionEvents(12, "acc");
    const unrelatedKey = queryKeys.sessionEvents(13, "acc");
    expect(matchingKey).not.toEqual(queryKeys.sessionEvents(12, "iracing"));
    queryClient.clear();
    queryClient.setQueryData(matchingKey, initial);
    queryClient.setQueryData(unrelatedKey, initial);
    mergeAppendedRaceEventsIntoCaches(12, [appended]);

    const matching = queryClient.getQueryData<typeof initial>(matchingKey);
    const unrelated = queryClient.getQueryData<typeof initial>(unrelatedKey);
    expect(matching && flattenRaceEventPages(matching.pages)).toHaveLength(201);
    expect(unrelated && flattenRaceEventPages(unrelated.pages)).toHaveLength(200);
    queryClient.clear();

    const cursors: string[] = [];
    const recovered = await recoverRaceEventTail(initial, async (cursor) => {
      cursors.push(cursor);
      return { items: [appended], nextCursor: null, tailCursor: "tail-201" };
    });

    expect(cursors).toEqual(["tail-200"]);
    expect(flattenRaceEventPages(recovered.pages)).toHaveLength(201);
    expect(recovered.pages[0]?.tailCursor).toBe("tail-201");

    await expect(
      recoverRaceEventTail(initial, async () => ({ items: [], nextCursor: "stalled", tailCursor: "tail-200" })),
    ).rejects.toThrow("Race-event tail catch-up cursor did not advance");
  });

  test("resets every game-scoped timeline cache when events are replaced", async () => {
    const data = {
      pages: [{ items: [event()], nextCursor: null, tailCursor: "tail-1" }],
      pageParams: [undefined],
    };
    const accKey = queryKeys.sessionEvents(12, "acc");
    const iracingKey = queryKeys.sessionEvents(12, "iracing");
    queryClient.setQueryData(accKey, data);
    queryClient.setQueryData(iracingKey, data);

    await resetRaceEventCaches(12);

    expect(queryClient.getQueryData(accKey)).toBeUndefined();
    expect(queryClient.getQueryData(iracingKey)).toBeUndefined();
    queryClient.clear();
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
        { items: [later], nextCursor: "page-two", tailCursor: "later" },
        { items: [earlier], nextCursor: null, tailCursor: "earlier" },
      ]).map((item) => item.eventId),
    ).toEqual([earlier.eventId, later.eventId]);
  });
});
