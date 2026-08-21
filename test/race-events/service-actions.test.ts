import { describe, expect, test } from "bun:test";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { observation, participant } from "./helpers";

describe("pit service action detector", () => {
  test("publishes proven tire, repair, and driver service in domain order", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 51 });
    coordinator.processObservation(51, observation(1));
    coordinator.processObservation(
      51,
      observation(2, {
        lapNumber: 7,
        sourceTimeMs: 70_000,
        participants: [
          participant({
            pitState: "pit-stall",
            speedMps: 0,
            driverId: "driver:1",
            tireWear: { fl: 0.5, fr: 0.4, rl: 0.3, rr: 0.2 },
            damage: { body: 10, engine: 3 },
          }),
        ],
      }),
    );

    const batch = coordinator.processObservation(
      51,
      observation(3, {
        lapNumber: 7,
        sourceTimeMs: 71_000,
        trackDistanceM: 2_100,
        trackDistancePct: 0.42,
        participants: [
          participant({
            pitState: "pit-stall",
            speedMps: 0,
            driverId: "driver:2",
            tireWear: { fl: 0.44, fr: 0.4, rl: 0.3, rr: 0.2 },
            damage: { body: 8.5, engine: 3 },
          }),
        ],
      }),
    );
    const actionEvents = batch.events.filter(({ eventType }) => eventType === "driver_changed" || eventType.endsWith("service_observed"));

    expect(actionEvents.map(({ eventType }) => eventType)).toEqual(["driver_changed", "driver_service_observed", "repair_service_observed", "tire_service_observed"]);
    expect(actionEvents[1]).toMatchObject({
      participantId: "local-player",
      participantKind: "player",
      driverId: "driver:2",
      lapNumber: 7,
      sourceTimeMs: 71_000,
      trackDistanceM: 2_100,
      trackDistancePct: 0.42,
      evidenceKind: "derived",
      confidence: "high",
      qualityState: "available",
      payload: { previousDriverId: "driver:1", driverId: "driver:2" },
    });
    expect(actionEvents[2]).toMatchObject({
      participantId: "local-player",
      lapNumber: 7,
      evidenceKind: "derived",
      qualityState: "available",
      payload: {
        previousComponents: { body: 10, engine: 3 },
        currentComponents: { body: 8.5, engine: 3 },
        repairedComponents: ["body"],
      },
    });
    expect(actionEvents[3]).toMatchObject({
      participantId: "local-player",
      lapNumber: 7,
      evidenceKind: "derived",
      qualityState: "available",
      payload: {
        changedCorners: ["fl"],
        previousCompound: "medium",
        currentCompound: "medium",
        beforeWear: { fl: 0.5, fr: 0.4, rl: 0.3, rr: 0.2 },
        afterWear: { fl: 0.44, fr: 0.4, rl: 0.3, rr: 0.2 },
      },
    });
    expect(new Set(actionEvents.slice(1).map(({ lifecycleId }) => lifecycleId)).size).toBe(1);
  });

  test("does not fabricate service below fuel, tire-wear, and repair thresholds", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 52 });
    coordinator.processObservation(52, observation(1));
    coordinator.processObservation(
      52,
      observation(2, {
        participants: [
          participant({
            pitState: "pit-lane",
            speedMps: 10,
            fuelLitres: 40,
            tireWear: { fl: 0.5, fr: 0.5, rl: 0.5, rr: 0.5 },
            damage: { body: 10 },
          }),
        ],
      }),
    );

    const belowThreshold = coordinator.processObservation(
      52,
      observation(3, {
        participants: [
          participant({
            pitState: "pit-lane",
            speedMps: 10,
            fuelLitres: 40.09,
            tireWear: { fl: 0.451, fr: 0.5, rl: 0.5, rr: 0.5 },
            damage: { body: 9.01 },
          }),
        ],
      }),
    );
    const types = belowThreshold.events.map(({ eventType }) => eventType);

    expect(types).not.toContain("pit_service_started");
    expect(types).not.toContain("fuel_service_observed");
    expect(types).not.toContain("tire_service_observed");
    expect(types).not.toContain("repair_service_observed");
    expect(types).not.toContain("driver_service_observed");
  });
});
