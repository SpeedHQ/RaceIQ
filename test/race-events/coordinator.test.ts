import { describe, expect, test } from "bun:test";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { RaceEventConflictError } from "../../server/race-events/ordering";
import { observation } from "./helpers";

describe("race-event coordinator", () => {
  test("produces stable semantic IDs and suppresses exact duplicate coordinates", () => {
    const first = new RaceEventCoordinator({ sessionId: 7 });
    const second = new RaceEventCoordinator({ sessionId: 7 });
    const sample = observation(10);

    const firstBatch = first.processObservation(7, sample);
    const secondBatch = second.processObservation(7, {
      ...sample,
      receivedAtMs: sample.receivedAtMs + 50_000,
    });
    expect(firstBatch.events.map(({ eventId }) => eventId)).toEqual(
      secondBatch.events.map(({ eventId }) => eventId),
    );

    const duplicate = first.processObservation(7, {
      ...sample,
      receivedAtMs: sample.receivedAtMs + 1,
    });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.reason).toBe("duplicate");
    expect(duplicate.events.map(({ eventType }) => eventType)).toEqual([
      "duplicate_input_suppressed",
    ]);
  });

  test("orders same-observation detector output by fixed domain priority", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 8 });
    const result = coordinator.processObservation(8, observation(1));
    const types = result.events.map(({ eventType }) => eventType);
    expect(types).toEqual([
      "source_connected",
      "session_started",
      "participant_joined",
      "driver_started_stint",
    ]);
    expect(result.events.map(({ eventOrder }) => eventOrder)).toEqual([
      0,
      10_000,
      20_000,
      30_000,
    ]);
  });

  test("reset evidence wins over a lower native sequence and seeds epoch one", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 9 });
    coordinator.processObservation(9, observation(100));
    const result = coordinator.processObservation(9, observation(2), {
      reconnect: true,
      resetReason: "source-reconnect",
    });

    expect(result.accepted).toBe(true);
    expect(result.timelineEpoch).toBe(1);
    expect(result.sequence).toBe(1);
    expect(
      result.events
        .filter(({ eventType }) =>
          eventType === "timebase_reset" ||
          eventType === "timeline_discontinuity",
        )
        .every(({ sequence }) => sequence === 0),
    ).toBe(true);
    expect(result.events.some(({ eventType }) => eventType === "out_of_order_input"))
      .toBe(false);
  });

  test("rejects a true unchanged-session lower sequence", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 10 });
    coordinator.processObservation(10, observation(100));
    const result = coordinator.processObservation(
      10,
      observation(99, { sourceTimeMs: 10_100 }),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("out-of-order");
    expect(result.events.map(({ eventType }) => eventType)).toEqual([
      "out_of_order_input",
    ]);
  });

  test("same native coordinate with different content is ambiguous and skipped", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 11 });
    coordinator.processObservation(11, observation(5));
    const result = coordinator.processObservation(
      11,
      observation(5, { trackDistanceM: 999 }),
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("ambiguous-coordinate");
    expect(result.events[0]).toMatchObject({
      eventType: "timeline_discontinuity",
      qualityState: "ambiguous",
    });
  });

  test("fails a same-ID semantic conflict", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 14 });
    coordinator.processObservation(14, observation(10));
    const evaluated = {
      lapNumber: 1,
      lapTimeMs: 90_000,
      isValid: true,
      phase: "flying" as const,
      conditions: [],
      invalidReason: null,
      rawBoundaryOrdinal: 10,
    };
    coordinator.noteLapEvaluated(evaluated);
    expect(() =>
      coordinator.noteLapEvaluated({ ...evaluated, lapTimeMs: 91_000 }),
    ).toThrow(RaceEventConflictError);
  });

  test("maps only verified ACC, AC Evo, and F1 race-control facts", () => {
    const acc = new RaceEventCoordinator({ sessionId: 12 });
    acc.processObservation(
      12,
      observation(1, {
        gameId: "acc",
        sessionPhase: "caution",
        cautionKind: "local-yellow",
        nativeRaceControlCode: "yellow",
      }),
    );
    const accClear = acc.processObservation(
      12,
      observation(2, {
        gameId: "acc",
        sessionPhase: "unknown",
        nativeRaceControlCode: "none",
      }),
    );
    expect(accClear.events.map(({ eventType }) => eventType)).toContain(
      "caution_ended",
    );
    expect(accClear.events.map(({ eventType }) => eventType)).not.toContain(
      "green_flag",
    );

    const f1 = new RaceEventCoordinator({ sessionId: 13 });
    f1.processObservation(
      13,
      observation(1, {
        gameId: "f1-2025",
        sessionPhase: "caution",
        cautionKind: "safety-car",
        nativeRaceControlCode: 1,
      }),
    );
    const f1Clear = f1.processObservation(
      13,
      observation(2, {
        gameId: "f1-2025",
        sessionPhase: "unknown",
        nativeRaceControlCode: 0,
      }),
    );
    expect(f1Clear.events.map(({ eventType }) => eventType)).toContain(
      "caution_ended",
    );
    expect(f1Clear.events.map(({ eventType }) => eventType)).not.toContain(
      "green_flag",
    );
  });
});
