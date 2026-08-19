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
});
