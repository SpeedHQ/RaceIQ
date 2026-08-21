import { describe, expect, test } from "bun:test";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { observation, participant } from "./helpers";

describe("participant and source-quality detectors", () => {
  test("requires two authoritative missing roster snapshots before unavailable", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 31 });
    coordinator.processObservation(
      31,
      observation(1, {
        gameId: "f1-2025",
        rosterAuthoritative: true,
        participants: [
          participant({
            participantId: "f1-car:0",
            identityState: "session-scoped",
          }),
        ],
      }),
    );
    const once = coordinator.processObservation(
      31,
      observation(2, {
        gameId: "f1-2025",
        rosterAuthoritative: true,
        participants: [],
      }),
    );
    expect(once.events.map(({ eventType }) => eventType)).not.toContain(
      "participant_became_unavailable",
    );
    const twice = coordinator.processObservation(
      31,
      observation(3, {
        gameId: "f1-2025",
        rosterAuthoritative: true,
        participants: [],
      }),
    );
    expect(twice.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "participant_became_unavailable",
          participantId: "f1-car:0",
        }),
      ]),
    );

    const returned = coordinator.processObservation(
      31,
      observation(4, {
        gameId: "f1-2025",
        rosterAuthoritative: true,
        participants: [
          participant({
            participantId: "f1-car:0",
            identityState: "session-scoped",
          }),
        ],
      }),
    );
    expect(returned.events.map(({ eventType }) => eventType)).toContain(
      "participant_returned",
    );
  });

  test("unknown driver data never clears or changes a known driver", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 32 });
    coordinator.processObservation(32, observation(1));
    const unknown = coordinator.processObservation(
      32,
      observation(2, { participants: [participant({ driverId: null })] }),
    );
    expect(unknown.events.map(({ eventType }) => eventType)).not.toContain(
      "driver_changed",
    );
    const changed = coordinator.processObservation(
      32,
      observation(3, {
        participants: [participant({ driverId: "driver:2" })],
      }),
    );
    expect(changed.events.map(({ eventType }) => eventType)).toContain(
      "driver_changed",
    );
  });

  test("holds an unscoped start until the first session binds", () => {
    const coordinator = new RaceEventCoordinator();
    expect(
      coordinator.noteSourceLifecycle({
        kind: "start",
        timestampMs: 50,
        eventId: "source-start:fixture",
      }),
    ).toEqual([]);
    const batch = coordinator.processObservation(33, observation(1));
    const connected = batch.events.find(
      ({ eventType }) => eventType === "source_connected",
    );
    expect(connected?.sourceTimeMs).toBe(50);
    expect(connected?.eventId).toMatch(/^race-event:sha256:/);
  });

  test("publishes gaps only from finalized shared tracker boundaries", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 34 });
    coordinator.processObservation(34, observation(1));
    const gaps = coordinator.noteSourceSequenceFinalized({
      summary: {
        expectedCount: 4,
        observedCount: 2,
        totalMissingCount: 2,
        totalMissingFraction: 0.5,
        largestContiguousGapMs: 300,
        countMethod: "native-sequence",
      },
      gaps: [
        {
          sourceSequenceFamily: "iracing-session-tick",
          previousSequence: 1,
          currentSequence: 4,
          previousSourceTimeMs: 100,
          currentSourceTimeMs: 400,
          previousObservationIndex: 0,
          currentObservationIndex: 1,
          durationMs: 300,
          missingCount: 2,
          countMethod: "native-sequence",
        },
      ],
      duplicates: [],
      outOfOrder: [],
      inferredIntervalMs: 100,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      eventType: "telemetry_gap",
      sourceTimeMs: 100,
      sourceEndTimeMs: 400,
      payload: { missingCount: 2, countMethod: "native-sequence" },
    });
  });
});
