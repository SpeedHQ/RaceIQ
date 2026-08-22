import { describe, expect, test } from "bun:test";

import { initServerGameAdapters } from "../../server/games/init";
import { iracingServerAdapter } from "../../server/games/iracing";
import { initGameAdapters } from "../../shared/games/init";
import { RaceEventSemanticProjector, applyRaceEventSemanticProjection } from "../../server/race-events/semantic-projector";

import { packet } from "../support/telemetry/resolver";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { observation, participant } from "./helpers";

initGameAdapters();
initServerGameAdapters();

function projectedIRacingObservation(
  projector: RaceEventSemanticProjector,
  {
    timestampMs,
    pitStall,
    pitServiceStatus,
    tireCount,
    tireWear,
    fuelLitres = 20,
    mandatoryRepair,
    optionalRepair,
  }: {
    timestampMs: number;
    pitStall: boolean;
    pitServiceStatus: number;
    tireCount: number;
    tireWear?: readonly [number, number, number, number];
    fuelLitres?: number;
    mandatoryRepair: number;
    optionalRepair: number;
  },
) {
  const normalized = packet("iracing", {
    TimestampMS: timestampMs,
    Fuel: fuelLitres,
    TireWearFL: tireWear?.[0],
    TireWearFR: tireWear?.[1],
    TireWearRL: tireWear?.[2],
    TireWearRR: tireWear?.[3],
    iracing: {
      sessionTick: timestampMs,
      sessionNum: 1,
      sessionFlags: 0x4,
      sessionState: 4,
      driverCarIdx: 0,
      trackLengthM: 1_000,
      lapDistanceM: 100,
      lapDistancePct: 0.1,
      onPitRoad: pitStall,
      playerTrackSurface: 0,
      incidents: 0,
      trackWetness: 0,
      PlayerCarInPitStall: pitStall,
      PlayerCarPitSvStatus: pitServiceStatus,
      TireSetsUsed: tireCount,
      PitRepairLeft: mandatoryRepair,
      PitOptRepairLeft: optionalRepair,
      carName: "test-car",
      carClassName: "test-class",
      trackName: "test-track",
    },
  });
  const semantic = projector.project(normalized, timestampMs);
  return applyRaceEventSemanticProjection(
    iracingServerAdapter.toRaceEventObservation(normalized, {
      receivedAtMs: timestampMs,
      sourceSequences: [],
      semantic,
    }),
    semantic,
  );
}

function changedCorners(payload: unknown): readonly string[] | null {
  if (
    payload == null ||
    typeof payload !== "object" ||
    !("changedCorners" in payload) ||
    !Array.isArray(payload.changedCorners) ||
    !payload.changedCorners.every((corner) => typeof corner === "string")
  ) {
    return null;
  }
  return payload.changedCorners;
}

function hasRepairTiming(payload: unknown): boolean {
  return payload != null &&
    typeof payload === "object" &&
    "previousRemainingSeconds" in payload &&
    payload.previousRemainingSeconds != null;
}

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

  test("retains identity across an unknown pit frame and detects one replacement driver", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 52 });
    coordinator.processObservation(52, observation(1));

    const arrival = coordinator.processObservation(
      52,
      observation(2, {
        participants: [
          participant({
            pitState: "pit-stall",
            speedMps: 0,
            sourceId: "car:42",
            identityState: "stable",
            driverId: "driver:1",
            teamId: "team:1",
            displayName: "Driver One",
            vehicleId: "car:1",
          }),
        ],
      }),
    );
    const lifecycleId = arrival.events.find(
      ({ eventType }) => eventType === "pit_stall_arrival",
    )?.lifecycleId;
    expect(lifecycleId).toEqual(expect.any(String));

    coordinator.processObservation(
      52,
      observation(3, {
        participants: [
          participant({
            pitState: "unknown",
            sourceId: null,
            identityState: "unknown",
            driverId: null,
            teamId: null,
            displayName: null,
            vehicleId: null,
          }),
        ],
      }),
    );

    const replacement = coordinator.processObservation(
      52,
      observation(4, {
        participants: [
          participant({
            pitState: "pit-stall",
            speedMps: 0,
            sourceId: "car:42",
            identityState: "stable",
            driverId: "driver:2",
            teamId: "team:2",
            displayName: "Driver Two",
            vehicleId: "car:2",
          }),
        ],
      }),
    );
    const driverServices = replacement.events.filter(
      ({ eventType }) => eventType === "driver_service_observed",
    );

    expect(replacement.events.filter(({ eventType }) => eventType === "driver_changed")).toHaveLength(1);
    expect(driverServices).toHaveLength(1);
    expect(driverServices[0]).toMatchObject({
      participantId: "local-player",
      participantKind: "player",
      driverId: "driver:2",
      teamId: "team:2",
      lifecycleId,
      payload: {
        previousDriverId: "driver:1",
        driverId: "driver:2",
      },
    });
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
  test("detects service delta on observed pit-entry packet", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 53 });
    coordinator.processObservation(53, observation(1, {
      participants: [participant({ damage: { body: 10 } })],
    }));
    const entry = coordinator.processObservation(53, observation(2, {
      participants: [participant({
        pitState: "pit-lane",
        fuelLitres: 48,
        tireWear: { fl: 0.1, fr: 0.1, rl: 0.1, rr: 0.1 },
        damage: { body: 0 },
        driverId: "driver:2",
      })],
    }));

    expect(entry.events.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining([
        "pit_entry",
        "repair_service_observed",
        "fuel_service_observed",
        "tire_service_observed",
        "driver_service_observed",
      ]),
    );
  });

  test("does not infer tire service from a fuel-only pit snapshot", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 54 });
    coordinator.processObservation(54, observation(1, {
      participants: [participant({
        fuelLitres: 20,
        tireWear: { fl: 0.8, fr: 0.8, rl: 0.8, rr: 0.8 },
        tireWearFreshness: "pit-snapshot",
      })],
    }));
    coordinator.processObservation(54, observation(2, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        fuelLitres: 20,
        tireWear: { fl: 0.8, fr: 0.8, rl: 0.8, rr: 0.8 },
        tireWearFreshness: "pit-snapshot",
      })],
    }));

    const actions = coordinator.processObservation(54, observation(3, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        fuelLitres: 35,
        tireWear: { fl: 0.1, fr: 0.1, rl: 0.1, rr: 0.1 },
        tireWearFreshness: "pit-snapshot",
      })],
    })).events.map(({ eventType }) => eventType);

    expect(actions).toContain("fuel_service_observed");
    expect(actions).not.toContain("tire_service_observed");
  });

  test("carries projected iRacing counters and repair evidence through one native service", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 60 });
    const projector = new RaceEventSemanticProjector();
    const observe = (values: Parameters<typeof projectedIRacingObservation>[1]) =>
      coordinator.processObservation(
        60,
        projectedIRacingObservation(projector, values),
      );

    observe({
      timestampMs: 1_000,
      pitStall: false,
      pitServiceStatus: 0,
      tireCount: 1,
      mandatoryRepair: 20,
      optionalRepair: 0,
    });
    observe({
      timestampMs: 2_000,
      pitStall: true,
      pitServiceStatus: 1,
      tireCount: 1,
      tireWear: [0.8, 0.7, 0.6, 0.5],
      mandatoryRepair: 20,
      optionalRepair: 0,
    });
    const actions = observe({
      timestampMs: 3_000,
      pitStall: true,
      pitServiceStatus: 1,
      tireCount: 2,
      tireWear: [0.1, 0.2, 0.3, 0.4],
      mandatoryRepair: 10,
      optionalRepair: 0,
    });
    observe({
      timestampMs: 4_000,
      pitStall: true,
      pitServiceStatus: 2,
      tireCount: 2,
      mandatoryRepair: 10,
      optionalRepair: 0,
    });
    const repeatedComplete = observe({
      timestampMs: 5_000,
      pitStall: true,
      pitServiceStatus: 2,
      tireCount: 2,
      mandatoryRepair: 10,
      optionalRepair: 0,
    });

    const tireEvents = actions.events.filter(({ eventType }) => eventType === "tire_service_observed");
    expect(tireEvents).toHaveLength(1);
    expect(changedCorners(tireEvents[0]?.payload)).toEqual(["fl", "fr", "rl", "rr"]);
    expect(tireEvents[0]?.payload).toMatchObject({
      beforeWear: { fl: 0.8, fr: 0.7, rl: 0.6, rr: 0.5 },
      afterWear: { fl: 0.1, fr: 0.2, rl: 0.3, rr: 0.4 },
    });
    const repairEvents = actions.events.filter(({ eventType }) => eventType === "repair_service_observed");
    expect(repairEvents).toHaveLength(1);
    expect(repairEvents[0]?.payload).toMatchObject({
      previousRemainingSeconds: { mandatory: 20, optional: 0 },
      currentRemainingSeconds: { mandatory: 10, optional: 0 },
    });
    expect(repeatedComplete.events.map(({ eventType }) => eventType)).not.toContain("pit_service_completed");
    expect(
      coordinator.events().filter(({ eventType }) => eventType === "pit_service_completed"),
    ).toHaveLength(1);
  });

  test("does not report tire service when native set count is unchanged during fuel service", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 62 });
    const projector = new RaceEventSemanticProjector();
    const observe = (values: Parameters<typeof projectedIRacingObservation>[1]) =>
      coordinator.processObservation(
        62,
        projectedIRacingObservation(projector, values),
      );

    observe({
      timestampMs: 1_000,
      pitStall: false,
      pitServiceStatus: 0,
      tireCount: 1,
      fuelLitres: 20,
      mandatoryRepair: 0,
      optionalRepair: 0,
    });
    observe({
      timestampMs: 2_000,
      pitStall: true,
      pitServiceStatus: 1,
      tireCount: 1,
      fuelLitres: 20,
      mandatoryRepair: 0,
      optionalRepair: 0,
    });
    const actions = observe({
      timestampMs: 3_000,
      pitStall: true,
      pitServiceStatus: 2,
      tireCount: 1,
      fuelLitres: 35,
      mandatoryRepair: 0,
      optionalRepair: 0,
    });

    expect(actions.events.map(({ eventType }) => eventType)).toContain(
      "fuel_service_observed",
    );
    expect(actions.events.map(({ eventType }) => eventType)).not.toContain(
      "tire_service_observed",
    );
  });
  test("uses native tire counters and repair countdowns across Richmond-like visits", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 55 });
    let sequence = 1;
    let tireCount = 1;
    coordinator.processObservation(55, observation(sequence++, {
      participants: [participant({
        fuelLitres: 20,
        tireWearFreshness: "pit-snapshot",
        tireChangeCounts: { fl: tireCount, fr: tireCount, rl: tireCount, rr: tireCount },
        repairRemainingSeconds: { mandatory: 0, optional: 0 },
      })],
    }));

    const visits = [
      { tires: true, fuel: true, repair: false },
      { tires: true, fuel: true, repair: true },
      { tires: true, fuel: true, repair: false },
      { tires: false, fuel: true, repair: true },
      { tires: false, fuel: false, repair: true },
      { tires: true, fuel: true, repair: true },
      { tires: true, fuel: true, repair: false },
    ] as const;

    for (const visit of visits) {
      const beforeRepair = visit.repair
        ? { mandatory: 20, optional: 0 }
        : { mandatory: 0, optional: 0 };
      coordinator.processObservation(55, observation(sequence++, {
        participants: [participant({
          pitState: "pit-stall",
          speedMps: 0,
          fuelLitres: 20,
          tireWear: { fl: 0.8, fr: 0.8, rl: 0.8, rr: 0.8 },
          tireWearFreshness: "pit-snapshot",
          tireChangeCounts: { fl: tireCount, fr: tireCount, rl: tireCount, rr: tireCount },
          repairRemainingSeconds: beforeRepair,
          pitServiceStatus: "in-progress",
        })],
      }));
      if (visit.tires) tireCount += 1;
      coordinator.processObservation(55, observation(sequence++, {
        participants: [participant({
          pitState: "pit-stall",
          speedMps: 0,
          fuelLitres: visit.fuel ? 35 : 20,
          tireWear: { fl: 0.1, fr: 0.1, rl: 0.1, rr: 0.1 },
          tireWearFreshness: "pit-snapshot",
          tireChangeCounts: { fl: tireCount, fr: tireCount, rl: tireCount, rr: tireCount },
          repairRemainingSeconds: visit.repair
            ? { mandatory: 10, optional: 0 }
            : beforeRepair,
          pitServiceStatus: "complete",
        })],
      }));
      coordinator.processObservation(55, observation(sequence++, {
        participants: [participant({
          pitState: "out",
          speedMps: 20,
          fuelLitres: visit.fuel ? 35 : 20,
          tireWearFreshness: "pit-snapshot",
          tireChangeCounts: { fl: tireCount, fr: tireCount, rl: tireCount, rr: tireCount },
          repairRemainingSeconds: { mandatory: 0, optional: 0 },
          pitServiceStatus: "none",
        })],
      }));
    }

    const events = coordinator.events();
    const tireEvents = events.filter(({ eventType }) => eventType === "tire_service_observed");
    expect(tireEvents).toHaveLength(5);
    expect(tireEvents.every(({ payload }) =>
      changedCorners(payload)?.join(",") === "fl,fr,rl,rr",
    )).toBe(true);
    expect(events.filter(({ eventType }) => eventType === "fuel_service_observed")).toHaveLength(6);
    const repairEvents = events.filter(({ eventType }) => eventType === "repair_service_observed");
    expect(repairEvents).toHaveLength(4);
    expect(repairEvents.every(({ payload }) => hasRepairTiming(payload))).toBe(true);
    expect(events.filter(({ eventType }) => eventType === "pit_service_completed")).toHaveLength(7);
  });

  test("emits native service completion once while status remains complete", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 56 });
    coordinator.processObservation(56, observation(1));
    coordinator.processObservation(56, observation(2, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "in-progress",
      })],
    }));
    coordinator.processObservation(56, observation(3, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "complete",
      })],
    }));
    const repeated = coordinator.processObservation(56, observation(4, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "complete",
      })],
    }));

    expect(repeated.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_service_completed",
    );
    expect(
      coordinator.events().filter(({ eventType }) => eventType === "pit_service_completed"),
    ).toHaveLength(1);
  });

});
