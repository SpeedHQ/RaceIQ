import { describe, expect, test } from "bun:test";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { observation, participant } from "./helpers";

describe("pit and service detector", () => {
  test("infers a stall only after two low-speed samples spanning 500ms", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 21 });
    coordinator.processObservation(21, observation(1));
    const entry = coordinator.processObservation(
      21,
      observation(2, {
        participants: [participant({ pitState: "pit-lane", speedMps: 10 })],
      }),
    );
    expect(entry.events.map(({ eventType }) => eventType)).toContain("pit_entry");

    const firstStop = coordinator.processObservation(
      21,
      observation(3, {
        sourceTimeMs: 1_000,
        participants: [participant({ pitState: "pit-lane", speedMps: 0.4 })],
      }),
    );
    expect(firstStop.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_stall_arrival",
    );

    const confirmed = coordinator.processObservation(
      21,
      observation(4, {
        sourceTimeMs: 1_600,
        participants: [participant({ pitState: "pit-lane", speedMps: 0.3 })],
      }),
    );
    expect(confirmed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "pit_stall_arrival",
          evidenceKind: "inferred",
        }),
        expect.objectContaining({ eventType: "pit_service_started" }),
      ]),
    );

    const stillStopped = coordinator.processObservation(
      21,
      observation(5, {
        sourceTimeMs: 1_700,
        participants: [participant({ pitState: "pit-lane", speedMps: 0.2 })],
      }),
    );
    expect(stillStopped.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_stall_departure",
    );

    const firstDepartureSample = coordinator.processObservation(
      21,
      observation(6, {
        sourceTimeMs: 2_000,
        participants: [participant({ pitState: "pit-lane", speedMps: 2.5 })],
      }),
    );
    expect(firstDepartureSample.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_stall_departure",
    );

    const departure = coordinator.processObservation(
      21,
      observation(7, {
        sourceTimeMs: 2_100,
        participants: [participant({ pitState: "pit-lane", speedMps: 3 })],
      }),
    );
    expect(departure.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "pit_stall_departure",
          evidenceKind: "inferred",
        }),
      ]),
    );
  });

  test("ignores one-frame pit-stall loss while native service remains in progress", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 63 });
    coordinator.processObservation(63, observation(1));
    const arrival = coordinator.processObservation(63, observation(2, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "in-progress",
      })],
    }));
    const flicker = coordinator.processObservation(63, observation(3, {
      participants: [participant({
        pitState: "pit-lane",
        speedMps: 0,
        pitServiceStatus: "in-progress",
      })],
    }));
    const restored = coordinator.processObservation(63, observation(4, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "in-progress",
      })],
    }));
    const completion = coordinator.processObservation(63, observation(5, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "complete",
      })],
    }));
    coordinator.processObservation(63, observation(6, {
      participants: [participant({
        pitState: "out",
        speedMps: 20,
        pitServiceStatus: "none",
      })],
    }));

    expect(arrival.events.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining(["pit_stall_arrival", "pit_service_started"]),
    );
    expect(flicker.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_stall_departure",
    );
    expect(restored.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_stall_arrival",
    );
    expect(completion.events.map(({ eventType }) => eventType)).toContain(
      "pit_service_completed",
    );
    expect(
      coordinator.events().filter(({ eventType }) => eventType === "pit_stall_arrival"),
    ).toHaveLength(1);
    expect(
      coordinator.events().filter(({ eventType }) => eventType === "pit_service_started"),
    ).toHaveLength(1);
    expect(
      coordinator.events().filter(({ eventType }) => eventType === "pit_service_completed"),
    ).toHaveLength(1);
  });

  test("records proven fuel service and completes it before pit exit", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 22 });
    coordinator.processObservation(22, observation(1));
    coordinator.processObservation(
      22,
      observation(2, {
        participants: [
          participant({ pitState: "pit-stall", speedMps: 0, fuelLitres: 30 }),
        ],
      }),
    );
    const fuel = coordinator.processObservation(
      22,
      observation(3, {
        participants: [
          participant({ pitState: "pit-stall", speedMps: 0, fuelLitres: 35.5 }),
        ],
      }),
    );
    const fuelEvent = fuel.events.find(
      ({ eventType }) => eventType === "fuel_service_observed",
    );
    expect(fuelEvent?.payload).toMatchObject({
      beforeLitres: 30,
      afterLitres: 35.5,
      addedLitres: 5.5,
    });

    const exit = coordinator.processObservation(
      22,
      observation(4, {
        sourceTimeMs: 2_000,
        participants: [
          participant({ pitState: "out", speedMps: 10, fuelLitres: 35.5 }),
        ],
      }),
    );
    const types = exit.events.map(({ eventType }) => eventType);
    expect(types).toEqual([
      "pit_service_completed",
      "pit_stall_departure",
      "pit_exit",
    ]);
    expect(
      coordinator
        .events()
        .filter(({ eventType }) => eventType.startsWith("pit_") || eventType.endsWith("service_observed"))
        .map(({ eventType }) => eventType),
    ).toEqual([
      "pit_entry",
      "pit_stall_arrival",
      "pit_service_started",
      "fuel_service_observed",
      "pit_service_completed",
      "pit_stall_departure",
      "pit_exit",
    ]);
    expect(
      new Set(
        coordinator
          .events()
          .filter(({ eventType }) => eventType.startsWith("pit_") || eventType.endsWith("service_observed"))
          .map(({ lifecycleId }) => lifecycleId),
      ).size,
    ).toBe(1);
  });

  test("distinguishes a drive-through and never fabricates service", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 23 });
    coordinator.processObservation(23, observation(1));
    coordinator.processObservation(
      23,
      observation(2, {
        participants: [participant({ pitState: "pit-lane", speedMps: 20 })],
      }),
    );
    const exit = coordinator.processObservation(
      23,
      observation(3, {
        participants: [participant({ pitState: "out", speedMps: 20 })],
      }),
    );
    expect(exit.events.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining(["drive_through_observed", "pit_exit"]),
    );
    expect(exit.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_service_completed",
    );
  });

  test("does not fabricate service for a known none lifecycle, but preserves legacy stall inference", () => {
    const knownNone = new RaceEventCoordinator({ sessionId: 57 });
    knownNone.processObservation(57, observation(1));
    knownNone.processObservation(57, observation(2, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "none",
      })],
    }));
    knownNone.processObservation(57, observation(3, {
      participants: [participant({
        pitState: "out",
        speedMps: 20,
        pitServiceStatus: "none",
      })],
    }));

    expect(
      knownNone.events().filter(({ eventType }) => eventType.includes("service")),
    ).toEqual([]);

    const seededNone = new RaceEventCoordinator({ sessionId: 58 });
    seededNone.processObservation(58, observation(1, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "none",
      })],
    }));
    seededNone.processObservation(58, observation(2, {
      participants: [participant({
        pitState: "out",
        speedMps: 20,
        pitServiceStatus: "none",
      })],
    }));

    expect(
      seededNone.events().filter(({ eventType }) => eventType.includes("service")),
    ).toEqual([]);

    const legacy = new RaceEventCoordinator({ sessionId: 59 });
    legacy.processObservation(59, observation(1));
    const arrival = legacy.processObservation(59, observation(2, {
      participants: [participant({ pitState: "pit-stall", speedMps: 0 })],
    }));
    const departure = legacy.processObservation(59, observation(3, {
      participants: [participant({ pitState: "out", speedMps: 20 })],
    }));

    expect(arrival.events.map(({ eventType }) => eventType)).toContain("pit_service_started");
    expect(departure.events.map(({ eventType }) => eventType)).toContain("pit_service_completed");
  });

  test("records late actions after native completion without reopening service", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 61 });
    coordinator.processObservation(61, observation(1, {
      participants: [participant({
        tireChangeCounts: { fl: 1, fr: 1, rl: 1, rr: 1 },
        repairRemainingSeconds: { mandatory: 10, optional: 0 },
      })],
    }));
    coordinator.processObservation(61, observation(2, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "in-progress",
        tireChangeCounts: { fl: 1, fr: 1, rl: 1, rr: 1 },
        repairRemainingSeconds: { mandatory: 10, optional: 0 },
      })],
    }));
    coordinator.processObservation(61, observation(3, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "complete",
        tireChangeCounts: { fl: 1, fr: 1, rl: 1, rr: 1 },
        repairRemainingSeconds: { mandatory: 10, optional: 0 },
      })],
    }));
    const lateAction = coordinator.processObservation(61, observation(4, {
      participants: [participant({
        pitState: "pit-stall",
        speedMps: 0,
        pitServiceStatus: "complete",
        tireChangeCounts: { fl: 2, fr: 2, rl: 2, rr: 2 },
        repairRemainingSeconds: { mandatory: 5, optional: 0 },
      })],
    }));
    const departure = coordinator.processObservation(61, observation(5, {
      participants: [participant({
        pitState: "out",
        speedMps: 20,
        pitServiceStatus: "none",
        tireChangeCounts: { fl: 2, fr: 2, rl: 2, rr: 2 },
        repairRemainingSeconds: { mandatory: 5, optional: 0 },
      })],
    }));

    const lateServiceActions = lateAction.events.filter(
      ({ eventType }) =>
        eventType === "tire_service_observed" ||
        eventType === "repair_service_observed",
    );
    expect(lateServiceActions.map(({ eventType }) => eventType)).toEqual(
      expect.arrayContaining([
        "tire_service_observed",
        "repair_service_observed",
      ]),
    );
    expect(lateServiceActions).toHaveLength(2);
    const tireEvent = lateServiceActions.find(
      ({ eventType }) => eventType === "tire_service_observed",
    );
    expect(tireEvent?.payload).toMatchObject({
      changedCorners: ["fl", "fr", "rl", "rr"],
    });
    expect(departure.events.map(({ eventType }) => eventType)).not.toContain(
      "pit_service_completed",
    );
    expect(
      coordinator.events().filter(({ eventType }) => eventType === "pit_service_started"),
    ).toHaveLength(1);
    expect(
      coordinator.events().filter(({ eventType }) => eventType === "pit_service_completed"),
    ).toHaveLength(1);
  });
  test("source end closes an open visit only as incomplete", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 24 });
    coordinator.processObservation(24, observation(1));
    coordinator.processObservation(
      24,
      observation(2, {
        participants: [participant({ pitState: "pit-lane", speedMps: 10 })],
      }),
    );
    const end = coordinator.endSession({
      reason: "stream-ended",
      terminalObserved: false,
    });
    expect(end.map(({ eventType }) => eventType)).toEqual([
      "pit_visit_incomplete",
    ]);
  });
});
