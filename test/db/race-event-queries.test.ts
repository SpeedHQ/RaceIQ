import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { RaceEventSchema, type RaceEvent, type RaceEventId } from "../../shared/racing/events/contracts";
import {
  RaceEventConflictError,
  appendRaceEvents,
  finalizeRaceEventSourceGeneration,
  listPitVisitRaceEvents,
  listRaceEventsForLap,
  listRaceEventsForLifecycle,
  listSessionRaceEvents,
  replaceReplayableSessionArtifacts,
} from "../../server/db/race-event-queries";
import { client, db } from "../../server/db";
import {
  laps,
  raceEvents,
  sessionResults,
  sessionRunLaps,
  sessions,
} from "../../server/db/schema";
import { DatabaseRaceEventStore } from "../../server/race-events/store";
import { SessionRunBuilder } from "../../server/session-runs/builder";

function eventId(value: number): RaceEventId {
  return `race-event:sha256:${value.toString(16).padStart(64, "0")}` as RaceEventId;
}

function contentHash(value: number): string {
  return `sha256:${value.toString(16).padStart(64, "0")}`;
}

function raceEvent(value: number, eventType: RaceEvent["eventType"], payload: RaceEvent["payload"], overrides: Partial<RaceEvent> = {}): RaceEvent {
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
    eventOrder: 20,
    sourceTimeMs: value * 1_000,
    sourceEndTimeMs: value * 1_000,
    sourceSequenceFamily: "test-sequence",
    sourceSequence: value,
    receivedAtMs: value * 1_000 + 5,
    lapNumber: null,
    lapId: null,
    trackDistanceM: null,
    trackDistancePct: null,
    worldPosition: null,
    evidenceKind: "observed",
    confidence: "high",
    qualityState: "available",
    sourceKind: "native-live",
    payload,
    lifecycleId: null,
    linkedEventId: null,
    detectorId: "race-event-query-test",
    detectorVersion: "1",
    sourceGeneration: null,
    analysisGenerationId: null,
    contentHash: contentHash(value),
    createdAt: "2026-08-18T12:00:00.000Z",
    ...overrides,
  } as RaceEvent;
}

async function insertSession(): Promise<void> {
  await db.insert(sessions).values({ id: 1, carOrdinal: 10, trackOrdinal: 20, gameId: "iracing" });
}

beforeEach(async () => {
  await db.delete(raceEvents);
  await db.delete(sessionResults);
  await db.delete(laps);
  await db.delete(sessions);
  await insertSession();
});

describe("race event persistence", () => {
  test("append is idempotent and rejects a semantic conflict", async () => {
    const joined = raceEvent(1, "participant_joined", {
      sourceId: "driver-1",
      identityState: "stable",
      displayName: "Driver One",
      vehicleId: "car-1",
    });

    expect((await appendRaceEvents([joined, joined])).map((event) => event.eventId)).toEqual([joined.eventId]);
    expect(await appendRaceEvents([joined])).toEqual([]);
    await expect(appendRaceEvents([{ ...joined, contentHash: contentHash(999) }])).rejects.toBeInstanceOf(RaceEventConflictError);

    const stored = await db.select().from(raceEvents);
    expect(stored).toHaveLength(1);
  });

  test("append participates in a caller transaction", async () => {
    const joined = raceEvent(1, "participant_joined", {
      sourceId: "driver-1",
      identityState: "stable",
      displayName: null,
      vehicleId: null,
    });
    await expect(
      db.transaction(async (tx) => {
        await appendRaceEvents([joined], tx);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(await db.select().from(raceEvents)).toEqual([]);
  });
  test("append with lap links commits before session quality exists", async () => {
    const lapId = (await db.insert(laps).values({ sessionId: 1, lapNumber: 1, lapTime: 90 }).returning({ id: laps.id }).get()).id;
    const event = raceEvent(1, "position_changed", { previousPosition: 2, position: 1 }, { lapNumber: 1 });

    const stored = await new DatabaseRaceEventStore().appendWithLapLinks([event], [{ sessionId: 1, lapNumber: 1, lapId }]);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.lapId).toBe(lapId);
  });
  test("idempotent append applies validated links to existing events", async () => {
    const lapId = (await db.insert(laps).values({ sessionId: 1, lapNumber: 1, lapTime: 90 }).returning({ id: laps.id }).get()).id;
    const event = raceEvent(1, "position_changed", { previousPosition: 2, position: 1 }, { lapNumber: 1 });
    const store = new DatabaseRaceEventStore();
    await store.append([event]);

    expect(await store.appendWithLapLinks([event], [{ sessionId: 1, lapNumber: 1, lapId }])).toEqual([]);
    expect((await db.select({ lapId: raceEvents.lapId }).from(raceEvents).where(eq(raceEvents.eventId, event.eventId)).get())?.lapId).toBe(lapId);
  });

  test("validates every lap link before appending any event", async () => {
    const lapId = (await db.insert(laps).values({ sessionId: 1, lapNumber: 1, lapTime: 90 }).returning({ id: laps.id }).get()).id;
    const laterLapId = (await db.insert(laps).values({ sessionId: 1, lapNumber: 3, lapTime: 90 }).returning({ id: laps.id }).get()).id;
    const event = raceEvent(2, "position_changed", { previousPosition: 2, position: 1 }, { lapNumber: 1 });

    await expect(
      new DatabaseRaceEventStore().appendWithLapLinks(
        [event],
        [
          { sessionId: 1, lapNumber: 1, lapId },
          { sessionId: 1, lapNumber: 2, lapId: laterLapId },
        ],
      ),
    ).rejects.toThrow("not lap 2 in session 1");
    expect(await db.select().from(raceEvents)).toEqual([]);
  });

  test("reads reject a row whose stored payload violates the event contract", async () => {
    await client.execute(
      `INSERT INTO race_events (
         event_id, event_type, schema_version, session_id, timeline_epoch,
         sequence, event_order, received_at_ms, evidence_kind, confidence,
         quality_state, source_kind, payload, detector_id, detector_version
       ) VALUES (
         'pit-event:corrupt', 'pit_entry', 'race-event-v1', 1, 0,
         1, 50, 1000, 'derived', 'unknown',
         'ambiguous', 'unknown', '{}', 'legacy-test', 'legacy-v1'
       )`,
    );
    await expect(listSessionRaceEvents(1)).rejects.toThrow();
  });

  test("list filters intersect and the opaque cursor preserves total order", async () => {
    const sourceConnected = raceEvent(1, "source_connected", { lifecycleKind: "start", details: null }, { participantId: null, participantKind: null, eventOrder: 0 });
    const position = raceEvent(2, "position_changed", { previousPosition: 5, position: 4 }, { sequence: 2, eventOrder: 20, lapNumber: 7, sourceTimeMs: 2_000, sourceEndTimeMs: 2_000 });
    const pitEntry = raceEvent(
      3,
      "pit_entry",
      { previousState: "out", state: "pit-lane" },
      {
        sequence: 2,
        eventOrder: 50,
        lapNumber: 7,
        sourceTimeMs: 2_500,
        sourceEndTimeMs: 2_500,
        lifecycleId: "pit-visit:1",
      },
    );
    const opponentPosition = raceEvent(4, "position_changed", { previousPosition: 8, position: 7 }, { participantId: "opponent:7", participantKind: "opponent", lapNumber: 7 });
    await appendRaceEvents([opponentPosition, pitEntry, position, sourceConnected]);

    const first = await listSessionRaceEvents(1, { limit: 2 });
    expect(first.items.map((event) => event.eventId)).toEqual([sourceConnected.eventId, position.eventId]);
    expect(first.nextCursor).toBe(first.tailCursor);
    const second = await listSessionRaceEvents(1, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((event) => event.eventId)).toEqual([pitEntry.eventId, opponentPosition.eventId]);
    expect(second.nextCursor).toBeNull();
    expect(second.tailCursor).not.toBeNull();

    const filtered = await listSessionRaceEvents(1, {
      participantId: "local-player",
      lapNumber: 7,
      fromSourceTimeMs: 2_100,
      toSourceTimeMs: 2_600,
      eventType: "pit_entry",
      lifecycleId: "pit-visit:1",
    });
    expect(filtered.items.map((event) => event.eventId)).toEqual([pitEntry.eventId]);
    expect((await listSessionRaceEvents(1, { qualityOnly: true })).items.map((event) => event.eventId)).toEqual([sourceConnected.eventId]);
    await expect(listSessionRaceEvents(1, { cursor: "not-a-cursor" })).rejects.toThrow("Invalid race-event cursor");
  });

  test("round-trips safe-integer cursor coordinates and rejects unsafe event rows", async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const first = raceEvent(maximum - 1, "position_changed", { previousPosition: 2, position: 1 }, {
      sequence: maximum,
      sourceTimeMs: 0,
      sourceEndTimeMs: 0,
      sourceSequence: maximum,
      receivedAtMs: maximum,
    });
    const second = raceEvent(maximum, "position_changed", { previousPosition: 1, position: 2 }, {
      sequence: maximum,
      sourceTimeMs: 0,
      sourceEndTimeMs: 0,
      sourceSequence: maximum,
      receivedAtMs: maximum,
    });
    expect(RaceEventSchema.safeParse({ ...first, sequence: maximum + 1 }).success).toBe(false);

    await appendRaceEvents([first, second]);
    const firstPage = await listSessionRaceEvents(1, { limit: 1 });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listSessionRaceEvents(1, { limit: 1, cursor: firstPage.nextCursor! });
    expect(secondPage.items.map((event) => event.eventId)).toEqual([second.eventId]);
  });

  test("lap, lifecycle, pit-visit, and source-generation helpers return validated rows", async () => {
    const lapId = (await db.insert(laps).values({ sessionId: 1, lapNumber: 7, lapTime: 90 }).returning({ id: laps.id }).get()).id;
    const pitEntry = raceEvent(
      1,
      "pit_entry",
      { previousState: "out", state: "pit-lane" },
      {
        eventOrder: 50,
        lapNumber: 7,
        lapId,
        lifecycleId: "pit-visit:1",
        sourceGeneration: "provisional:native-live:local-player:test",
      },
    );
    const fuel = raceEvent(
      2,
      "fuel_service_observed",
      { beforeLitres: 10, afterLitres: 20, addedLitres: 10 },
      {
        eventOrder: 60,
        lapNumber: 7,
        lapId,
        lifecycleId: "pit-visit:1",
        linkedEventId: pitEntry.eventId,
      },
    );
    const incident = raceEvent(3, "incident_observed", { previousCount: 0, currentCount: 2, delta: 2 }, { lapNumber: 7, lapId, lifecycleId: "incident:1", eventOrder: 70 });
    await appendRaceEvents([pitEntry, fuel, incident]);

    expect((await listRaceEventsForLap(lapId)).map((event) => event.eventId)).toEqual([pitEntry.eventId, fuel.eventId, incident.eventId]);
    expect((await listRaceEventsForLifecycle(1, "pit-visit:1")).map((event) => event.eventId)).toEqual([pitEntry.eventId, fuel.eventId]);
    expect((await listPitVisitRaceEvents(1, "pit-visit:1")).map((event) => event.eventId)).toEqual([pitEntry.eventId, fuel.eventId]);

    expect(await finalizeRaceEventSourceGeneration(1, "raw:verified:abc123")).toBe(3);
    const generations = await db.select({ eventId: raceEvents.eventId, sourceGeneration: raceEvents.sourceGeneration }).from(raceEvents).orderBy(raceEvents.eventId);
    expect(generations).toEqual([
      { eventId: pitEntry.eventId, sourceGeneration: "raw:verified:abc123" },
      { eventId: fuel.eventId, sourceGeneration: "raw:verified:abc123" },
      { eventId: incident.eventId, sourceGeneration: "raw:verified:abc123" },
    ]);
    expect(await finalizeRaceEventSourceGeneration(1, "raw:verified:different")).toBe(0);
  });

  test("replay replacement rolls back every staged mutation and then atomically activates", async () => {
    const oldLapId = (await db.insert(laps).values({ sessionId: 1, lapNumber: 7, lapTime: 91 }).returning({ id: laps.id }).get()).id;
    const transport = raceEvent(1, "source_connected", { lifecycleKind: "start", details: null }, { participantId: null, participantKind: null, eventOrder: 0, lapNumber: null, lapId: null });
    const oldEvent = raceEvent(2, "position_changed", { previousPosition: 5, position: 4 }, { lapNumber: 7, lapId: oldLapId });
    await appendRaceEvents([transport, oldEvent]);
    await db.insert(sessionResults).values({
      sessionId: 1,
      sessionType: "race",
      classification: "finished",
      eventIds: [oldEvent.eventId],
    });

    const replacement = raceEvent(3, "pit_exit", { previousState: "pit-lane", state: "out" }, { eventOrder: 50, lapNumber: 8, lifecycleId: "pit-visit:2" });
    const result = {
      processorVersion: "race-result-v3",
      sessionType: "race",
      classification: "finished",
      outcomeStatus: "confirmed" as const,
      finishingPosition: 4,
      qualifyingPosition: 5,
      isPodium: false,
      isFastestLap: false,
      pitCount: 1,
      tyreStrategy: null,
      fuelStrategy: null,
      provenance: null,
      reasons: [],
      evidence: null,
      eventIds: [replacement.eventId],
    };

    await client.execute(
      `CREATE TRIGGER fail_race_event_activation
       BEFORE INSERT ON race_events
       WHEN NEW.event_id = '${replacement.eventId}'
       BEGIN
         SELECT RAISE(ABORT, 'forced activation failure');
       END`,
    );
    await expect(
      replaceReplayableSessionArtifacts({
        sessionId: 1,
        events: [replacement],
        runs: [],
        memberships: [],
        evidence: [],
        laps: [{ lapNumber: 8, lapTime: 89 }],
        result,
      }),
    ).rejects.toThrow();
    await client.execute("DROP TRIGGER fail_race_event_activation");

    expect(await db.select({ id: laps.id, lapNumber: laps.lapNumber }).from(laps)).toEqual([{ id: oldLapId, lapNumber: 7 }]);
    expect((await listSessionRaceEvents(1)).items.map((event) => event.eventId)).toEqual([transport.eventId, oldEvent.eventId]);
    expect((await db.select().from(sessionResults).where(eq(sessionResults.sessionId, 1)).get())?.eventIds).toEqual([oldEvent.eventId]);

    const activated = await replaceReplayableSessionArtifacts({
      sessionId: 1,
      events: [replacement],
      runs: [],
      memberships: [],
      evidence: [],
      laps: [{ lapNumber: 8, lapTime: 89 }],
      result,
    });
    expect(activated.conflictCount).toBe(0);
    const newLapId = activated.lapIdsByNumber.get(8);
    expect(typeof newLapId).toBe("number");
    expect(activated.events[0]).toMatchObject({ eventId: replacement.eventId, lapId: newLapId });
    expect((await listSessionRaceEvents(1)).items.map((event) => event.eventId)).toEqual([transport.eventId, replacement.eventId]);
    expect((await db.select().from(sessionResults).where(eq(sessionResults.sessionId, 1)).get())?.eventIds).toEqual([replacement.eventId]);
  });
  test("validates replacement lap ownership before a caller transaction mutates", async () => {
    const oldEvent = raceEvent(1, "position_changed", {
      previousPosition: 2,
      position: 1,
    });
    await appendRaceEvents([oldEvent]);
    await db
      .insert(sessions)
      .values({ id: 2, carOrdinal: 11, trackOrdinal: 21, gameId: "iracing" });
    const foreignLapId = (
      await db
        .insert(laps)
        .values({ sessionId: 2, lapNumber: 1, lapTime: 90 })
        .returning({ id: laps.id })
        .get()
    ).id;
    const replacement = raceEvent(
      2,
      "position_changed",
      { previousPosition: 1, position: 2 },
      { lapNumber: 1, lapId: foreignLapId },
    );

    await db.transaction(async (tx) => {
      await expect(
        replaceReplayableSessionArtifacts(
          {
            sessionId: 1,
            events: [replacement],
            runs: [],
            memberships: [],
            evidence: [],
          },
          tx,
        ),
      ).rejects.toThrow("references a lap outside its session");
    });

    expect((await listSessionRaceEvents(1)).items.map(({ eventId }) => eventId)).toEqual([
      oldEvent.eventId,
    ]);
  });
  test("event-only replacement repairs materialized result event IDs", async () => {
    const event = raceEvent(1, "position_changed", { previousPosition: 2, position: 1 });
    await appendRaceEvents([event]);
    await db.insert(sessionResults).values({
      sessionId: 1,
      sessionType: "race",
      classification: "finished",
      eventIds: [event.eventId],
    });

    await replaceReplayableSessionArtifacts({
      sessionId: 1,
      events: [],
      runs: [],
      memberships: [],
      evidence: [],
    });

    expect((await db.select({ eventIds: sessionResults.eventIds }).from(sessionResults).where(eq(sessionResults.sessionId, 1)).get())?.eventIds).toEqual([]);
  });

  test("replaces retained pre-lifecycle source facts instead of duplicating them", async () => {
    const legacyConnected = raceEvent(
      21,
      "source_connected",
      { lifecycleKind: "start", details: "first accepted session observation" },
      {
        participantId: null,
        participantKind: null,
        eventOrder: 0,
        detectorId: "source-quality",
        detectorVersion: "1",
        sourceSequenceFamily: "kunos-graphics",
        sourceSequence: 11,
      },
    );
    await appendRaceEvents([legacyConnected]);

    const lifecycleId = "race-lifecycle:sha256:source-connection";
    const connected = {
      ...legacyConnected,
      eventId: eventId(22),
      lifecycleId,
      sourceSequenceFamily: "kunos-physics",
      sourceSequence: 63,
      detectorVersion: "2",
      contentHash: contentHash(22),
    } as RaceEvent;
    const disconnected = raceEvent(
      23,
      "source_disconnected",
      { lifecycleKind: "stop", details: null },
      {
        participantId: null,
        participantKind: null,
        eventOrder: 0,
        lifecycleId,
        linkedEventId: connected.eventId,
        detectorId: "source-quality",
        detectorVersion: "2",
      },
    );

    const replaced = await replaceReplayableSessionArtifacts({
      sessionId: 1,
      events: [connected, disconnected],
      runs: [],
      memberships: [],
      evidence: [],
    });

    expect(replaced.events.map(({ eventId }) => eventId)).toEqual([connected.eventId, disconnected.eventId]);
    expect((await listSessionRaceEvents(1)).items.map(({ eventId }) => eventId)).toEqual([connected.eventId, disconnected.eventId]);
  });

  test("replay replacement permits changed-version conflicts but rejects same-version conflicts", async () => {
    const old = raceEvent(1, "position_changed", { previousPosition: 3, position: 2 });
    await appendRaceEvents([old]);
    const changed = {
      ...old,
      detectorVersion: "2",
      payload: { previousPosition: 3, position: 1 },
      contentHash: contentHash(99),
    } as RaceEvent;
    const replaced = await replaceReplayableSessionArtifacts({
      sessionId: 1,
      events: [changed],
      runs: [],
      memberships: [],
      evidence: [],
    });
    expect(replaced.conflictCount).toBe(1);
    expect(replaced.events[0]).toMatchObject({ detectorVersion: "2", payload: changed.payload });

    await expect(
      replaceReplayableSessionArtifacts({
        sessionId: 1,
        events: [{ ...changed, contentHash: contentHash(100) }],
        runs: [],
        memberships: [],
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(RaceEventConflictError);
  });
  test("recomputes pit projections from baseline lap classification after event-only replacement", async () => {
    const lapId = (await db.insert(laps).values({
      sessionId: 1,
      lapNumber: 1,
      lapTime: 90,
      phase: "grid_start",
      conditions: ["formation"],
      paceEligibility: "excluded",
    }).returning({ id: laps.id }).get()).id;
    const lapCompleted = raceEvent(
      1,
      "lap_completed",
      { lapNumber: 1, lapTimeMs: 90_000, isValid: true, phase: "grid_start", conditions: ["formation"] },
      { lapNumber: 1, lapId, eventOrder: 20 },
    );
    const pitEntry = raceEvent(
      2,
      "pit_entry",
      { previousState: "out", state: "pit-lane" },
      { lapNumber: 1, lapId, eventOrder: 50 },
    );
    await appendRaceEvents([lapCompleted, pitEntry]);
    expect((await db.select({ phase: laps.phase, paceEligibility: laps.paceEligibility }).from(laps).where(eq(laps.id, lapId)).get())).toEqual({
      phase: "in",
      paceEligibility: "excluded",
    });

    await replaceReplayableSessionArtifacts({
      sessionId: 1,
      events: [lapCompleted],
      runs: [],
      memberships: [],
      evidence: [],
    });
    expect((await db.select({ phase: laps.phase, conditions: laps.conditions, paceEligibility: laps.paceEligibility }).from(laps).where(eq(laps.id, lapId)).get())).toEqual({
      phase: "grid_start",
      conditions: ["formation"],
      paceEligibility: "excluded",
    });
  });

  test("keeps opponent memberships detached from player lap rows", async () => {
    const playerJoined = raceEvent(10, "participant_joined", {
      sourceId: "player",
      identityState: "stable",
      displayName: "Player",
      vehicleId: "player-car",
    });
    const opponentJoined = raceEvent(
      11,
      "participant_joined",
      {
        sourceId: "opponent",
        identityState: "stable",
        displayName: "Opponent",
        vehicleId: "opponent-car",
      },
      {
        participantId: "opponent",
        participantKind: "opponent",
      },
    );
    const playerLap = raceEvent(
      12,
      "lap_completed",
      {
        lapNumber: 1,
        lapTimeMs: 90_000,
        isValid: true,
        phase: "flying",
        conditions: [],
      },
      { lapNumber: 1 },
    );
    const opponentLap = raceEvent(
      13,
      "lap_completed",
      {
        lapNumber: 1,
        lapTimeMs: 91_000,
        isValid: true,
        phase: "flying",
        conditions: [],
      },
      {
        participantId: "opponent",
        participantKind: "opponent",
        lapNumber: 1,
      },
    );
    const ended = raceEvent(
      14,
      "session_ended",
      {
        phase: "finished",
        previousPhase: "green",
        reason: "complete",
        terminalObserved: true,
        nativeCode: null,
      },
      { participantId: null, participantKind: null },
    );
    const events = [
      playerJoined,
      opponentJoined,
      playerLap,
      opponentLap,
      ended,
    ];
    const builder = new SessionRunBuilder();
    const artifacts = builder.consume({
      events,
      lapsByCompletionEventId: {},
    });
    const activated = await replaceReplayableSessionArtifacts({
      sessionId: 1,
      events,
      runs: artifacts.runs,
      memberships: artifacts.memberships,
      evidence: artifacts.evidence,
      laps: [{ lapNumber: 1, lapTime: 90 }],
    });
    const rows = await db
      .select({
        lapEventId: sessionRunLaps.lapEventId,
        lapId: sessionRunLaps.lapId,
      })
      .from(sessionRunLaps);
    expect(
      rows
        .filter(({ lapEventId }) => lapEventId === playerLap.eventId)
        .every(({ lapId }) => lapId === activated.lapIdsByNumber.get(1)),
    ).toBe(true);
    expect(
      rows
        .filter(({ lapEventId }) => lapEventId === opponentLap.eventId)
        .every(({ lapId }) => lapId === null),
    ).toBe(true);

    await replaceReplayableSessionArtifacts({
      sessionId: 1,
      events,
      runs: artifacts.runs,
      memberships: artifacts.memberships,
      evidence: artifacts.evidence,
    });
    const preservedRows = await db
      .select({
        lapEventId: sessionRunLaps.lapEventId,
        lapId: sessionRunLaps.lapId,
      })
      .from(sessionRunLaps);
    expect(
      preservedRows
        .filter(({ lapEventId }) => lapEventId === playerLap.eventId)
        .every(({ lapId }) => lapId === activated.lapIdsByNumber.get(1)),
    ).toBe(true);
  });
});
