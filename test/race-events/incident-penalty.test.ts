import { describe, expect, test } from "bun:test";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { observation, participant } from "./helpers";

const incidentEventTypes = ["incident_observed", "damage_warning_started", "damage_warning_cleared", "penalty_issued", "penalty_cleared", "retirement_observed"] as const;

describe("incident, damage, penalty, and retirement detector", () => {
  test("orders positive evidence and preserves participant and lap anchors", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 61 });
    coordinator.processObservation(
      61,
      observation(1, {
        lapNumber: 8,
        participants: [
          participant({
            incidentCount: 2,
            damage: { body: 0, engine: 0 },
            penaltyValue: 0,
          }),
        ],
      }),
    );

    const raised = coordinator.processObservation(
      61,
      observation(2, {
        sourceTimeMs: 81_250,
        lapNumber: 8,
        trackDistanceM: 1_250,
        trackDistancePct: 0.25,
        participants: [
          participant({
            incidentCount: 5,
            damage: { body: 2, engine: 0 },
            penaltyValue: 5,
            retirementStatus: "retired",
            nativeRetirementCode: 7,
          }),
        ],
      }),
    );
    const raisedEvents = raised.events.filter(({ eventType }) => incidentEventTypes.some((type) => type === eventType));

    expect(raisedEvents.map(({ eventType }) => eventType)).toEqual(["damage_warning_started", "incident_observed", "penalty_issued", "retirement_observed"]);
    expect(raisedEvents[0]).toMatchObject({
      participantId: "local-player",
      participantKind: "player",
      driverId: "driver:1",
      lapNumber: 8,
      sourceTimeMs: 81_250,
      trackDistanceM: 1_250,
      trackDistancePct: 0.25,
      evidenceKind: "derived",
      confidence: "high",
      qualityState: "available",
      payload: {
        previousComponents: { body: 0, engine: 0 },
        currentComponents: { body: 2, engine: 0 },
        changedComponents: ["body"],
      },
    });
    expect(raisedEvents[1]).toMatchObject({
      participantId: "local-player",
      lapNumber: 8,
      evidenceKind: "observed",
      qualityState: "available",
      payload: { previousCount: 2, currentCount: 5, delta: 3 },
    });
    expect(raisedEvents[2]).toMatchObject({
      participantId: "local-player",
      lapNumber: 8,
      evidenceKind: "observed",
      qualityState: "available",
      payload: { previousValue: 0, currentValue: 5, nativeCode: null },
    });
    expect(raisedEvents[3]).toMatchObject({
      participantId: "local-player",
      lapNumber: 8,
      evidenceKind: "observed",
      qualityState: "available",
      payload: { nativeCode: 7, status: "retired" },
    });

    const cleared = coordinator.processObservation(
      61,
      observation(3, {
        sourceTimeMs: 82_000,
        lapNumber: 8,
        participants: [
          participant({
            incidentCount: 5,
            damage: { body: 0.5, engine: 0 },
            penaltyValue: 0,
            retirementStatus: "retired",
            nativeRetirementCode: 7,
          }),
        ],
      }),
    );
    const clearedEvents = cleared.events.filter(({ eventType }) => incidentEventTypes.some((type) => type === eventType));

    expect(clearedEvents.map(({ eventType }) => eventType)).toEqual(["damage_warning_cleared", "penalty_cleared"]);
    expect(clearedEvents[0]).toMatchObject({
      participantId: "local-player",
      lapNumber: 8,
      evidenceKind: "derived",
      qualityState: "available",
      payload: {
        previousComponents: { body: 2, engine: 0 },
        currentComponents: { body: 0.5, engine: 0 },
        changedComponents: ["body", "engine"],
      },
    });
    expect(clearedEvents[1]).toMatchObject({
      participantId: "local-player",
      lapNumber: 8,
      evidenceKind: "observed",
      qualityState: "available",
      payload: {
        previousValue: 5,
        currentValue: 0,
        nativeCode: null,
        resolution: "unknown",
      },
    });
  });

  test("enforces damage start and clear thresholds without retirement fabrication", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 62 });
    coordinator.processObservation(
      62,
      observation(1, {
        participants: [participant({ damage: { body: 0 } })],
      }),
    );

    const belowStart = coordinator.processObservation(
      62,
      observation(2, {
        participants: [
          participant({
            damage: { body: 0.99 },
            retirementStatus: "retired",
            nativeRetirementCode: null,
          }),
        ],
      }),
    );
    expect(belowStart.events.map(({ eventType }) => eventType)).not.toContain("damage_warning_started");
    expect(belowStart.events.map(({ eventType }) => eventType)).not.toContain("retirement_observed");

    const started = coordinator.processObservation(
      62,
      observation(3, {
        participants: [participant({ damage: { body: 2 } })],
      }),
    );
    expect(started.events.map(({ eventType }) => eventType)).toContain("damage_warning_started");

    const aboveClear = coordinator.processObservation(
      62,
      observation(4, {
        participants: [participant({ damage: { body: 0.51 } })],
      }),
    );
    expect(aboveClear.events.map(({ eventType }) => eventType)).not.toContain("damage_warning_cleared");

    const clearedAtThreshold = coordinator.processObservation(
      62,
      observation(5, {
        participants: [participant({ damage: { body: 0.5 } })],
      }),
    );
    expect(clearedAtThreshold.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "damage_warning_cleared",
          evidenceKind: "derived",
          qualityState: "available",
        }),
      ]),
    );
  });

  test("unknown participant states do not clear or fabricate detector transitions", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 63 });
    coordinator.processObservation(63, observation(1));
    coordinator.processObservation(
      63,
      observation(2, {
        participants: [participant({ damage: { body: 2 }, penaltyValue: 4, incidentCount: 1 })],
      }),
    );

    const unknown = coordinator.processObservation(
      63,
      observation(3, {
        sessionPhase: "unknown",
        cautionKind: "unknown",
        participants: [
          participant({
            pitState: "unknown",
            nativePitCode: null,
            fuelLitres: null,
            tireCompound: null,
            tireWear: null,
            damage: null,
            penaltyValue: null,
            incidentCount: null,
            retirementStatus: "unknown",
            nativeRetirementCode: null,
          }),
        ],
      }),
    );
    const forbidden = [
      "session_phase_changed",
      "pit_entry",
      "pit_exit",
      "pit_service_started",
      "fuel_service_observed",
      "tire_service_observed",
      "repair_service_observed",
      "incident_observed",
      "damage_warning_started",
      "damage_warning_cleared",
      "penalty_issued",
      "penalty_cleared",
      "retirement_observed",
    ] as const;

    expect(unknown.events.filter(({ eventType }) => forbidden.some((type) => type === eventType))).toEqual([]);
  });
});
