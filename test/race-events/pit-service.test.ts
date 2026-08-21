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
