import { describe, expect, test } from "bun:test";

import {
  RACE_EVENT_SCHEMA_VERSION,
  type RaceEvent,
  type RaceEventPayloadMap,
  type RaceEventType,
} from "../../shared/racing/events/contracts";
import { SessionRunBuilder } from "../../server/session-runs/builder";
import { RaceEventConflictError } from "../../server/race-events/ordering";

let eventOrdinal = 0;
function raceEvent<Type extends RaceEventType>(
  eventType: Type,
  payload: RaceEventPayloadMap[Type],
  overrides: Partial<RaceEvent> = {},
): RaceEvent {
  eventOrdinal += 1;
  const hex = eventOrdinal.toString(16).padStart(64, "0");
  return {
    eventId: `race-event:sha256:${hex}`,
    eventType,
    schemaVersion: RACE_EVENT_SCHEMA_VERSION,
    sessionId: 1,
    participantId: eventType.startsWith("session_") ? null : "car-1",
    participantKind: eventType.startsWith("session_") ? null : "player",
    driverId: "driver-1",
    teamId: null,
    timelineEpoch: 0,
    sequence: eventOrdinal,
    eventOrder: 10,
    sourceTimeMs: eventOrdinal * 1_000,
    sourceEndTimeMs: eventOrdinal * 1_000,
    sourceSequenceFamily: "test",
    sourceSequence: eventOrdinal,
    receivedAtMs: eventOrdinal * 1_000,
    lapNumber: null,
    lapId: null,
    trackDistanceM: eventOrdinal * 100,
    trackDistancePct: 0.1,
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
    contentHash: `sha256:${hex}`,
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  } as RaceEvent;
}

function participantJoined() {
  return raceEvent("participant_joined", {
    sourceId: "car-1",
    identityState: "stable",
    displayName: "Driver",
    vehicleId: "car",
  });
}

function completedLap(lapNumber: number) {
  return raceEvent(
    "lap_completed",
    {
      lapNumber,
      lapTimeMs: 90_000 + lapNumber,
      isValid: true,
      phase: "flying",
      conditions: [],
    },
    { lapNumber },
  );
}

describe("SessionRunBuilder", () => {
  test("splits fuel pace while preserving tire, driver, and participant runs", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    const lap1 = completedLap(1);
    const fuel = raceEvent("fuel_service_observed", {
      beforeLitres: 10,
      afterLitres: 20,
      addedLitres: 10,
    });
    const lap2 = completedLap(2);
    const ended = raceEvent(
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

    const prepared = builder.consume({
      events: [joined, lap1, fuel, lap2, ended],
      lapsByCompletionEventId: {},
    });

    expect(prepared.runs.filter(({ runKind }) => runKind === "pace")).toHaveLength(2);
    expect(prepared.runs.filter(({ runKind }) => runKind === "tire")).toHaveLength(1);
    const tire = prepared.runs.find(({ runKind }) => runKind === "tire");
    expect(tire?.summary.completedLapCount).toBe(2);
    expect(
      prepared.memberships.filter(({ runId }) => runId === tire?.runId),
    ).toHaveLength(2);
    prepared.commit();
    expect(builder.openRuns()).toHaveLength(0);
  });

  test("keeps the final lap after the checkered phase begins", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    const lap1 = completedLap(1);
    const checkered = raceEvent(
      "checkered_flag",
      { nativeCode: null },
      { participantId: null, participantKind: null, eventOrder: 10 },
    );
    const lap2 = {
      ...completedLap(2),
      sequence: checkered.sequence,
      eventOrder: 40,
    } as RaceEvent;
    const ended = raceEvent(
      "session_ended",
      {
        phase: "finished",
        previousPhase: "checkered",
        reason: "complete",
        terminalObserved: true,
        nativeCode: null,
      },
      { participantId: null, participantKind: null },
    );

    const prepared = builder.consume({
      events: [joined, lap1, checkered, lap2, ended],
      lapsByCompletionEventId: {},
    });

    expect(
      prepared.memberships.filter(({ lapEventId }) => lapEventId === lap2.eventId),
    ).toHaveLength(4);
    expect(
      prepared.runs.filter(
        ({ startLapEventId, summary }) =>
          startLapEventId === lap2.eventId && summary.completedLapCount === 1,
      ),
    ).toHaveLength(4);
  });

  test("evicts completed session state after commit", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    const lap = completedLap(1);
    const ended = raceEvent(
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
    const prepared = builder.consume({
      events: [joined, lap, ended],
      lapsByCompletionEventId: {},
    });
    prepared.commit();

    const state = Reflect.get(builder, "state");
    if (!state || typeof state !== "object") {
      throw new Error("Session run builder state is unavailable");
    }
    for (const key of [
      "consumedEvents",
      "participants",
      "accumulators",
      "pendingEvidence",
      "phases",
      "epochs",
      "tireState",
    ]) {
      const collection = Reflect.get(state, key);
      expect(collection).toBeInstanceOf(Map);
      if (!(collection instanceof Map)) {
        throw new Error(`Session run builder ${key} is not a Map`);
      }
      expect(collection.size).toBe(0);
    }
    const awaitingRedRestart = Reflect.get(state, "awaitingRedRestart");
    expect(awaitingRedRestart).toBeInstanceOf(Set);
    if (!(awaitingRedRestart instanceof Set)) {
      throw new Error("Session run builder awaitingRedRestart is not a Set");
    }
    expect(awaitingRedRestart.size).toBe(0);
  });

  test("does not advance state until commit and committed duplicate batches are no-ops", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    const lap = completedLap(1);
    const first = builder.consume({
      events: [joined, lap],
      lapsByCompletionEventId: {},
    });
    expect(builder.openRuns()).toHaveLength(0);
    first.commit();
    expect(builder.openRuns()).toHaveLength(4);

    const duplicate = builder.consume({
      events: [joined, lap],
      lapsByCompletionEventId: {},
    });
    expect(duplicate.runs).toHaveLength(0);
    duplicate.commit();
    expect(builder.openRuns()).toHaveLength(4);
  });

  test("rejects conflicting duplicate event IDs without committing", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    builder.consume({ events: [joined], lapsByCompletionEventId: {} }).commit();
    const conflicting = {
      ...joined,
      contentHash: `sha256:${"f".repeat(64)}`,
    } as RaceEvent;
    expect(() =>
      builder.consume({ events: [conflicting], lapsByCompletionEventId: {} }),
    ).toThrow(RaceEventConflictError);
    expect(builder.openRuns()).toHaveLength(4);
  });

  test("opens participantless memberships without borrowing player identity", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const lap = completedLap(1);
    const unknownLap = {
      ...lap,
      participantId: null,
      participantKind: null,
      driverId: null,
    } as RaceEvent;
    const prepared = builder.consume({
      events: [unknownLap],
      lapsByCompletionEventId: {},
    });
    expect(prepared.nextBuilderState).toHaveLength(4);
    expect(prepared.nextBuilderState.every(({ participantId }) => participantId === null)).toBe(true);
    expect(prepared.nextBuilderState.every(({ qualityFlags }) => qualityFlags.includes("participant_identity_unavailable"))).toBe(true);
  });

  test("drops adjacent boundary-only pace intervals", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    const lap1 = completedLap(1);
    const fuel1 = raceEvent("fuel_service_observed", {
      beforeLitres: 10,
      afterLitres: 20,
      addedLitres: 10,
    });
    const fuel2 = raceEvent("fuel_service_observed", {
      beforeLitres: 20,
      afterLitres: 30,
      addedLitres: 10,
    });
    const lap2 = completedLap(2);
    const prepared = builder.consume({
      events: [joined, lap1, fuel1, fuel2, lap2],
      lapsByCompletionEventId: {},
    });
    const finalized = (() => {
      prepared.commit();
      return builder.finalize();
    })();
    expect(
      [...prepared.runs, ...finalized.runs].filter(
        ({ runKind }) => runKind === "pace",
      ),
    ).toHaveLength(2);
  });

  test("deduplicates exact same-batch events and rejects conflicting ones", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    const lap = completedLap(1);
    const ended = raceEvent(
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
    const prepared = builder.consume({
      events: [joined, lap, lap, ended],
      lapsByCompletionEventId: {},
    });
    expect(
      prepared.runs.every(
        ({ summary }) => summary.completedLapCount === 1,
      ),
    ).toBe(true);
    expect(prepared.memberships).toHaveLength(4);

    const other = {
      ...joined,
      contentHash: `sha256:${"f".repeat(64)}`,
    } as RaceEvent;
    expect(() =>
      new SessionRunBuilder().consume({
        events: [joined, other],
        lapsByCompletionEventId: {},
      }),
    ).toThrow(RaceEventConflictError);
  });

  test("clears tire identity across source recovery", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = participantJoined();
    const lap1 = completedLap(1);
    const tire = raceEvent("tire_service_observed", {
      changedCorners: ["fl", "fr"],
      previousCompound: "medium",
      currentCompound: "soft",
      beforeWear: null,
      afterWear: null,
    });
    const lap2 = completedLap(2);
    const disconnected = raceEvent("source_disconnected", {
      lifecycleKind: "timeout",
      details: null,
    });
    const recovered = raceEvent("source_recovered", {
      lifecycleKind: "reconnect",
      details: null,
    });
    const prepared = builder.consume({
      events: [joined, lap1, tire, lap2, disconnected, recovered],
      lapsByCompletionEventId: {},
    });
    expect(
      prepared.nextBuilderState.every(
        ({ tireCompound, tireSetId }) =>
          tireCompound === null && tireSetId === null,
      ),
    ).toBe(true);
    expect(
      prepared.nextBuilderState.every(({ qualityFlags }) =>
        qualityFlags.includes("source_continuity_unknown"),
      ),
    ).toBe(true);
  });

  test("keeps null and literal unknown participants distinct", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const unknownLap = {
      ...completedLap(1),
      participantId: null,
      participantKind: null,
      driverId: null,
    } as RaceEvent;
    const literalJoin = {
      ...participantJoined(),
      participantId: "<unknown>",
    } as RaceEvent;
    const prepared = builder.consume({
      events: [unknownLap, literalJoin],
      lapsByCompletionEventId: {},
    });
    expect(
      new Set(prepared.nextBuilderState.map(({ participantId }) => participantId)),
    ).toEqual(new Set([null, "<unknown>"]));
    expect(prepared.nextBuilderState).toHaveLength(8);
  });

  test("normalizes empty canonical text and validates finalization shape", () => {
    eventOrdinal = 0;
    const builder = new SessionRunBuilder();
    const joined = {
      ...participantJoined(),
      participantId: "",
      driverId: "",
      teamId: "",
      sourceGeneration: "",
    } as RaceEvent;
    const lap = {
      ...completedLap(1),
      participantId: "",
      driverId: "",
      teamId: "",
      sourceGeneration: "",
    } as RaceEvent;
    const prepared = builder.consume({
      events: [joined, lap],
      lapsByCompletionEventId: {},
    });
    expect(
      prepared.nextBuilderState.every(
        ({ participantId, driverId, teamId, sourceGeneration }) =>
          participantId === null &&
          driverId === null &&
          teamId === null &&
          sourceGeneration === null,
      ),
    ).toBe(true);
    prepared.commit();
    expect(() =>
      builder.finalize({ reason: "session-ended" } as never),
    ).toThrow("requires a session_ended event");
    expect(() =>
      builder.finalize({ event: joined } as never),
    ).toThrow("cannot include an event");
    const finalized = builder.finalize();
    expect(finalized.runs.every(({ createdAt }) => createdAt === joined.createdAt)).toBe(
      true,
    );
  });
});
