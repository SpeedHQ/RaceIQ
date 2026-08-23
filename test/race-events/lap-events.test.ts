import { describe, expect, test } from "bun:test";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { lapEvaluation, observation, participant } from "./helpers";

describe("lap event detector", () => {
  test("starts a new physical lap with participant and observation anchors", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 41 });
    coordinator.processObservation(41, observation(1));

    const batch = coordinator.processObservation(
      41,
      observation(2, {
        sourceTimeMs: 91_000,
        lapNumber: 2,
        currentLapTimeMs: 250,
        trackDistanceM: 25,
        trackDistancePct: 0.005,
        participants: [participant({ position: 3 })],
      }),
    );
    const started = batch.events.find(({ eventType }) => eventType === "lap_started");

    expect(started).toMatchObject({
      participantId: "local-player",
      participantKind: "player",
      driverId: "driver:1",
      lapNumber: 2,
      sourceTimeMs: 91_000,
      trackDistanceM: 25,
      trackDistancePct: 0.005,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
      payload: {
        lapNumber: 2,
        phase: "flying",
        conditions: [],
      },
    });
  });

  test("completes and invalidates a lap before publishing valid sector samples", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 42 });
    coordinator.processObservation(
      42,
      observation(10, {
        sourceTimeMs: 95_000,
        lapNumber: 4,
        trackDistanceM: 4_800,
        trackDistancePct: 0.96,
        participants: [participant({ position: 5 })],
      }),
    );

    const events = coordinator.noteLapEvaluated(
      lapEvaluation({
        lapNumber: 4,
        lapTimeMs: 94_321,
        isValid: false,
        invalidReason: "track-limit",
        phase: "in",
        conditions: ["caution"],
        sectors: [30.125, Number.NaN, -1, 31.5],
        position: 5,
        rawBoundaryOffset: 2_048,
        rawBoundaryOrdinal: 7,
      }),
    );

    expect(events.map(({ eventType }) => eventType)).toEqual(["lap_completed", "sector_completed", "sector_completed", "track_limit_or_lap_invalidated"]);
    expect(events[0]).toMatchObject({
      participantId: "local-player",
      lapNumber: 4,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
      payload: {
        lapNumber: 4,
        lapTimeMs: 94_321,
        isValid: false,
        phase: "in",
        conditions: ["caution"],
      },
    });
    const sectorEvents = events.filter(({ eventType }) => eventType === "sector_completed");
    expect(sectorEvents).toHaveLength(2);
    expect(sectorEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: "local-player",
          lapNumber: 4,
          evidenceKind: "derived",
          qualityState: "available",
          payload: { lapNumber: 4, sectorIndex: 0, sectorTimeMs: 30_125 },
        }),
        expect.objectContaining({
          participantId: "local-player",
          lapNumber: 4,
          evidenceKind: "derived",
          qualityState: "available",
          payload: { lapNumber: 4, sectorIndex: 3, sectorTimeMs: 31_500 },
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      participantId: "local-player",
      lapNumber: 4,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "degraded",
      payload: { lapNumber: 4, reason: "track-limit" },
    });
  });

  test("emits position changes only at completed-lap boundaries and orders them first", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 43 });
    coordinator.processObservation(43, observation(1, { participants: [participant({ position: 6 })] }));
    const firstBoundary = coordinator.noteLapEvaluated(lapEvaluation({ lapNumber: 1, position: 6, rawBoundaryOrdinal: 1 }));
    expect(firstBoundary.map(({ eventType }) => eventType)).not.toContain("position_changed");

    const midLap = coordinator.processObservation(
      43,
      observation(2, {
        lapNumber: 2,
        participants: [participant({ position: 4 })],
      }),
    );
    expect(midLap.events.map(({ eventType }) => eventType)).not.toContain("position_changed");

    const secondBoundary = coordinator.noteLapEvaluated(
      lapEvaluation({
        lapNumber: 2,
        position: 4,
        sectors: [29, 30, 31],
        rawBoundaryOrdinal: 2,
      }),
    );

    expect(secondBoundary.map(({ eventType }) => eventType)).toEqual(["position_changed", "lap_completed", "sector_completed", "sector_completed", "sector_completed"]);
    expect(secondBoundary[0]).toMatchObject({
      participantId: "local-player",
      participantKind: "player",
      lapNumber: 2,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
      payload: { previousPosition: 6, position: 4 },
    });
  });
});
