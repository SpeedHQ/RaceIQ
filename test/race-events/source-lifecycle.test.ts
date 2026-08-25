import { describe, expect, test } from "bun:test";

import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { observation } from "./helpers";

describe("source lifecycle detector", () => {
  test("publishes source lifecycle transitions in order", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 71 });
    const initial = coordinator.processObservation(
      71,
      observation(1, {
        lapNumber: 3,
        trackDistanceM: 900,
        trackDistancePct: 0.18,
      }),
    );
    const connected = initial.events.find(({ eventType }) => eventType === "source_connected");

    expect(connected).toMatchObject({
      participantId: null,
      participantKind: null,
      lapNumber: 3,
      trackDistanceM: 900,
      trackDistancePct: 0.18,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
      payload: {
        lifecycleKind: "start",
        details: "first accepted session observation",
      },
    });

    const stale = coordinator
      .noteSourceLifecycle({
        kind: "timeout",
        timestampMs: 1_000,
        eventId: "source:timeout:fixture",
        details: "packet deadline exceeded",
      })
      .find(({ eventType }) => eventType === "source_stale");
    const recovered = coordinator
      .noteSourceLifecycle({
        kind: "reconnect",
        timestampMs: 2_000,
        eventId: "source:reconnect:fixture",
        details: "packets resumed",
      })
      .find(({ eventType }) => eventType === "source_recovered");
    const disconnected = coordinator
      .noteSourceLifecycle({
        kind: "stop",
        timestampMs: 3_000,
        eventId: "source:stop:fixture",
        details: "reader stopped",
      })
      .find(({ eventType }) => eventType === "source_disconnected");

    expect([stale?.eventType, recovered?.eventType, disconnected?.eventType]).toEqual(["source_stale", "source_recovered", "source_disconnected"]);
    expect(stale).toMatchObject({
      participantId: null,
      lapNumber: 3,
      sourceTimeMs: 1_000,
      sourceEndTimeMs: 1_000,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "unavailable",
      payload: {
        lifecycleKind: "timeout",
        details: "packet deadline exceeded",
      },
    });
    expect(recovered).toMatchObject({
      participantId: null,
      lapNumber: 3,
      sourceTimeMs: 2_000,
      sourceEndTimeMs: 2_000,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
      payload: { lifecycleKind: "reconnect", details: "packets resumed" },
    });
    expect(disconnected).toMatchObject({
      participantId: null,
      lapNumber: 3,
      sourceTimeMs: 3_000,
      sourceEndTimeMs: 3_000,
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
      payload: { lifecycleKind: "stop", details: "reader stopped" },
    });
  });
});
