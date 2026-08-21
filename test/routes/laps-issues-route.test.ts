/**
 * GET /api/laps/:id/issues — per-lap tune issue feed route. Uses the real
 * (test) SQLite DB directly, same convention as lap-legacy-detection.test.ts,
 * since getLapById reads through the raw session file rather than a mockable
 * layer.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { RaceEvent, RaceEventId } from "../../shared/racing/events/contracts";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import { db } from "../../server/db/index";
import { sessions, laps } from "../../server/db/schema";
import { eq } from "drizzle-orm";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { raceEventIdsSupportingTuneIssue } from "../../server/routes/tune-chat-routes";
import { tuneRoutes } from "../../server/routes/tune-routes";

initGameAdapters();
initServerGameAdapters();

const TRACK_ORDINAL = 434343;

async function insertSession(rawFile: string | null): Promise<number> {
  const row = await db.insert(sessions).values({ carOrdinal: 1, trackOrdinal: TRACK_ORDINAL, gameId: "fm-2023", rawFile }).returning({ id: sessions.id }).get();
  return row!.id;
}

async function insertLap(sessionId: number, lapNumber: number): Promise<number> {
  const row = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime: 90.0,
      isValid: true,
      rawByteOffset: null,
      rawFrameCount: null,
    })
    .returning({ id: laps.id })
    .get();
  return row!.id;
}

function eventId(value: number): RaceEventId {
  return `race-event:sha256:${value.toString(16).padStart(64, "0")}` as RaceEventId;
}

function canonicalEvent(
  value: number,
  eventType: RaceEvent["eventType"],
  payload: unknown,
  overrides: Partial<RaceEvent> = {},
): RaceEvent {
  return {
    eventId: eventId(value),
    eventType,
    schemaVersion: "race-event-v1",
    sessionId: 1,
    participantId: "local-player",
    participantKind: "player",
    driverId: null,
    teamId: null,
    timelineEpoch: 0,
    sequence: value,
    eventOrder: 70,
    sourceTimeMs: value * 1_000,
    sourceEndTimeMs: value * 1_000,
    sourceSequenceFamily: null,
    sourceSequence: null,
    receivedAtMs: value * 1_000,
    lapNumber: 7,
    lapId: 1,
    trackDistanceM: 2_000,
    trackDistancePct: 0.4,
    worldPosition: null,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
    sourceKind: "native-live",
    payload,
    lifecycleId: null,
    linkedEventId: null,
    detectorId: "test",
    detectorVersion: "1",
    sourceGeneration: null,
    analysisGenerationId: null,
    contentHash: `sha256:${value.toString(16).padStart(64, "0")}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as RaceEvent;
}


describe("GET /api/laps/:id/issues", () => {
  const sessionIds: number[] = [];

  afterEach(async () => {
    for (const sid of sessionIds) {
      await db.delete(laps).where(eq(laps.sessionId, sid)).run();
      await db.delete(sessions).where(eq(sessions.id, sid)).run();
    }
    sessionIds.length = 0;
  });

  test("legacy lap with no current quality evidence rejects generated issues", async () => {
    const sid = await insertSession(null); // no rawFile → legacy, telemetry === []
    sessionIds.push(sid);
    const lapId = await insertLap(sid, 1);

    const res = await tuneRoutes.request(`/api/laps/${lapId}/issues`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      decision: { status: string; reasons: { code: string }[] };
    };
    expect(body.decision.status).toBe("unknown");
    expect(body.decision.reasons.map(({ code }) => code)).toEqual(["quality_not_rebuilt"]);
  });

  test("does not infer support from lap, participant, family, or proximity", () => {
    const issue: TuneIssue = {
      kind: "brake-lockup",
      severity: "critical",
      corner: "T6",
      distanceFrac: 0.4,
      detail: "Wheel lockup under braking",
      lapNumber: 7,
    };
    const opponentPit = canonicalEvent(
      1,
      "pit_entry",
      { previousState: "out", state: "pit-lane" },
      { participantId: "opponent:4", participantKind: "opponent" },
    );
    const participantFact = canonicalEvent(2, "participant_joined", {
      sourceId: "player:1",
      identityState: "stable",
      displayName: null,
      vehicleId: null,
    });
    const raceControlFact = canonicalEvent(
      3,
      "caution_started",
      { kind: "local-yellow", nativeCode: null },
      { participantId: null, participantKind: null },
    );
    const unrelatedPlayerPit = canonicalEvent(4, "pit_entry", {
      previousState: "out",
      state: "pit-lane",
    });
    const distantPlayerIncident = canonicalEvent(
      5,
      "incident_observed",
      { previousCount: 0, currentCount: 1, delta: 1 },
      { trackDistanceM: 3_500, trackDistancePct: 0.7 },
    );
    const opponentIncident = canonicalEvent(
      6,
      "incident_observed",
      { previousCount: 0, currentCount: 1, delta: 1 },
      { participantId: "opponent:4", participantKind: "opponent" },
    );
    const unavailableIncident = canonicalEvent(
      7,
      "incident_observed",
      { previousCount: 0, currentCount: 1, delta: 1 },
      { qualityState: "unavailable" },
    );
    const nearbyPlayerIncident = canonicalEvent(
      8,
      "incident_observed",
      { previousCount: 0, currentCount: 1, delta: 1 },
      { trackDistanceM: 2_050, trackDistancePct: 0.41 },
    );

    expect(
      raceEventIdsSupportingTuneIssue(issue, [
        opponentPit,
        participantFact,
        raceControlFact,
        unrelatedPlayerPit,
        distantPlayerIncident,
        opponentIncident,
        unavailableIncident,
        nearbyPlayerIncident,
      ]),
    ).toEqual([]);
  });

  test("keeps explicitly derived canonical support after ownership validation", () => {
    const explicitlyLinkedPlayerIncident = canonicalEvent(
      10,
      "incident_observed",
      { previousCount: 0, currentCount: 1, delta: 1 },
      { trackDistanceM: 2_050, trackDistancePct: 0.41 },
    );
    const unrelatedPlayerEvent = canonicalEvent(11, "pit_entry", {
      previousState: "out",
      state: "pit-lane",
    });
    const explicitlyLinkedOpponentPit = canonicalEvent(
      12,
      "pit_entry",
      { previousState: "out", state: "pit-lane" },
      { participantId: "opponent:4", participantKind: "opponent" },
    );
    const explicitlyLinkedWrongLapIncident = canonicalEvent(
      13,
      "incident_observed",
      { previousCount: 0, currentCount: 1, delta: 1 },
      { lapNumber: 8 },
    );
    const explicitlyLinkedUnavailableIncident = canonicalEvent(
      14,
      "incident_observed",
      { previousCount: 0, currentCount: 1, delta: 1 },
      { qualityState: "unavailable" },
    );
    const issue: TuneIssue = {
      kind: "brake-lockup",
      severity: "critical",
      corner: "T6",
      distanceFrac: 0.4,
      detail: "Wheel lockup under braking",
      lapNumber: 7,
      eventIds: [
        explicitlyLinkedOpponentPit.eventId,
        explicitlyLinkedWrongLapIncident.eventId,
        explicitlyLinkedUnavailableIncident.eventId,
        explicitlyLinkedPlayerIncident.eventId,
      ],
    };

    expect(
      raceEventIdsSupportingTuneIssue(issue, [
        explicitlyLinkedOpponentPit,
        explicitlyLinkedWrongLapIncident,
        explicitlyLinkedUnavailableIncident,
        unrelatedPlayerEvent,
        explicitlyLinkedPlayerIncident,
      ]),
    ).toEqual([explicitlyLinkedPlayerIncident.eventId]);
  });

  test("does not fabricate canonical support for aggregate findings", () => {
    const aggregateIssue: TuneIssue = {
      kind: "tyre-pressure",
      severity: "warn",
      detail: "FL pressure +2.0 psi vs target",
      lapNumber: 7,
    };
    const playerIncident = canonicalEvent(9, "incident_observed", {
      previousCount: 0,
      currentCount: 1,
      delta: 1,
    });

    expect(raceEventIdsSupportingTuneIssue(aggregateIssue, [playerIncident])).toEqual([]);
  });

  test("unknown lap id returns 404", async () => {
    const res = await tuneRoutes.request("/api/laps/999999999/issues");
    expect(res.status).toBe(404);
  });
});
