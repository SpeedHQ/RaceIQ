import { describe, expect, test } from "bun:test";
import { acEvoServerAdapter } from "../../server/games/ac-evo";
import { accServerAdapter } from "../../server/games/acc";
import { initServerGameAdapters } from "../../server/games/init";

import type { RaceEvent } from "../../shared/racing/events/contracts";
import type { RaceEventObservation } from "../../server/games/types";
import { RaceEventCoordinator } from "../../server/race-events/coordinator";
import { RaceEventConflictError } from "../../server/race-events/ordering";
import type { DetectorEventDraft } from "../../server/race-events/types";
import { initGameAdapters } from "../../shared/games/init";
import { packet } from "../support/telemetry/resolver";
import {
  applyRaceEventSemanticProjection,
  RaceEventSemanticProjector,
} from "../../server/race-events/semantic-projector";
import { observation, participant } from "./helpers";
interface CoordinatorMaterializer {
  materializeDrafts(
    drafts: readonly DetectorEventDraft[],
    currentObservation: RaceEventObservation,
    timelineEpoch: number,
    sequence: number,
  ): { events: RaceEvent[]; rejectedDrafts: Array<{ eventType: string; error: string }> };
}

initGameAdapters();
initServerGameAdapters();


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

  test("aborts accepted preflight before retrying detector work", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 19 });
    coordinator.processObservation(19, observation(1, {
      gameId: "f1-2025",
      sessionPhase: "caution",
      cautionKind: "safety-car",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }));

    const failed = coordinator.preflight(observation(1, {
      gameId: "f1-2025",
      sourceTimeMs: 200,
    }), {
      reconnect: true,
      resetReason: "source-reconnect",
    });
    expect(failed).toMatchObject({ accepted: true, timelineEpoch: 1, sequence: 1, reset: true });
    coordinator.abortPreflight(failed);

    const retried = coordinator.preflight(observation(2, {
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }));
    expect(retried).toMatchObject({ accepted: true, timelineEpoch: 0, sequence: 2, reset: false });
    expect(coordinator.processPreflight(retried).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ eventType: "caution_ended" })]),
    );
    expect(coordinator.processObservation(19, observation(3, {
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }))).toMatchObject({
      accepted: true,
      sequence: 3,
    });
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

  test("keeps authoritative caution active through formation across games", () => {
    const acc = new RaceEventCoordinator({ sessionId: 12 });
    acc.processObservation(
      12,
      observation(1, {
        gameId: "acc",
        sessionPhase: "caution",
        cautionKind: "local-yellow",
        nativeRaceControlCode: "yellow",
        raceControlEvidence: "authoritative",
      }),
    );
    const accFormation = acc.processObservation(
      12,
      observation(2, {
        gameId: "acc",
        sessionPhase: "formation",
        nativeRaceControlCode: "none",
        raceControlEvidence: "authoritative",
      }),
    );
    expect(accFormation.events.map(({ eventType }) => eventType)).not.toContain(
      "caution_ended",
    );

    const f1 = new RaceEventCoordinator({ sessionId: 13 });
    f1.processObservation(
      13,
      observation(1, {
        gameId: "f1-2025",
        sessionPhase: "caution",
        cautionKind: "safety-car",
        nativeRaceControlCode: 1,
        raceControlEvidence: "authoritative",
      }),
    );
    const f1Formation = f1.processObservation(
      13,
      observation(2, {
        gameId: "f1-2025",
        sessionPhase: "formation",
        nativeRaceControlCode: 0,
        raceControlEvidence: "authoritative",
      }),
    );
    expect(f1Formation.events.map(({ eventType }) => eventType)).not.toContain(
      "caution_ended",
    );
  });
  test("keeps one caution lifecycle through revoked restarts and repeated cycles", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 20 });
    const canonical = {
      gameId: "iracing" as const,
      raceControlEvidence: "authoritative" as const,
      nativeRaceControlCode: null,
    };
    const results = [
      coordinator.processObservation(20, observation(1, {
        ...canonical,
        sessionPhase: "formation",
      })),
      coordinator.processObservation(20, observation(2, {
        ...canonical,
        sessionPhase: "green",
      })),
      coordinator.processObservation(20, observation(3, {
        ...canonical,
        sessionPhase: "caution",
        cautionKind: "full-course-yellow",
      })),
      coordinator.processObservation(20, observation(4, {
        ...canonical,
        sessionPhase: "formation",
      })),
      coordinator.processObservation(20, observation(5, {
        ...canonical,
        sessionPhase: "caution",
        cautionKind: "full-course-yellow",
      })),
      coordinator.processObservation(20, observation(6, {
        ...canonical,
        sessionPhase: "formation",
      })),
      coordinator.processObservation(20, observation(7, {
        ...canonical,
        sessionPhase: "green",
      })),
      coordinator.processObservation(20, observation(8, {
        ...canonical,
        sessionPhase: "caution",
        cautionKind: "full-course-yellow",
      })),
      coordinator.processObservation(20, observation(9, {
        ...canonical,
        sessionPhase: "formation",
      })),
      coordinator.processObservation(20, observation(10, {
        ...canonical,
        sessionPhase: "green",
      })),
      coordinator.processObservation(20, observation(11, {
        ...canonical,
        sessionPhase: "checkered",
      })),
    ];
    const raceControlEventTypes: Partial<Record<RaceEvent["eventType"], true>> = {
      green_flag: true,
      caution_started: true,
      caution_ended: true,
      restart_started: true,
      checkered_flag: true,
    };
    const raceControlEvents = results
      .flatMap(({ events }) => events)
      .filter(({ eventType }) => raceControlEventTypes[eventType] === true);

    expect(results[3].events.map(({ eventType }) => eventType)).not.toContain(
      "caution_ended",
    );
    expect(results[4].events.map(({ eventType }) => eventType)).not.toContain(
      "caution_started",
    );
    expect(results[5].events.map(({ eventType }) => eventType)).not.toContain(
      "caution_ended",
    );
    expect(raceControlEvents.map(({ eventType }) => eventType)).toEqual([
      "green_flag",
      "caution_started",
      "caution_ended",
      "green_flag",
      "restart_started",
      "caution_started",
      "caution_ended",
      "green_flag",
      "restart_started",
      "checkered_flag",
    ]);
    expect(raceControlEvents.every(({ detectorVersion }) => detectorVersion === "3")).toBe(true);
  });
  test("does not infer unverified canonical phases", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 21 });
    coordinator.processObservation(21, observation(1, {
      gameId: "iracing",
      sessionPhase: "formation",
    }));
    const green = coordinator.processObservation(21, observation(2, {
      gameId: "iracing",
      sessionPhase: "green",
    }));
    const checkered = coordinator.processObservation(21, observation(3, {
      gameId: "iracing",
      sessionPhase: "checkered",
    }));

    expect(green.events.map(({ eventType }) => eventType)).not.toContain("green_flag");
    expect(checkered.events.map(({ eventType }) => eventType)).not.toContain("checkered_flag");
  });
  test("rejects lower native sequence before implicit time rollback reset", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 15 });
    coordinator.processObservation(15, observation(100, { sourceTimeMs: 10_000 }));
    const result = coordinator.processObservation(15, observation(99, { sourceTimeMs: 9_000 }));

    expect(result).toMatchObject({
      accepted: false,
      reason: "out-of-order",
      timelineEpoch: 0,
    });
  });

  test("F1 normal race-control closes caution without ending live lap-data", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 16 });
    coordinator.processObservation(16, observation(1, {
      gameId: "f1-2025",
      sessionPhase: "caution",
      cautionKind: "safety-car",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }));
    const live = coordinator.processObservation(16, observation(2, {
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 0,
      terminalObserved: false,
      raceControlEvidence: "authoritative",
    }));

    expect(live.events.map(({ eventType }) => eventType)).toContain("caution_ended");
    expect(live.events.map(({ eventType }) => eventType)).not.toContain("session_ended");
  });

  test("F1 final classification ends session once", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 17 });
    coordinator.processObservation(17, observation(1, {
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 0,
      terminalObserved: false,
      raceControlEvidence: "authoritative",
    }));
    const finalClassification = coordinator.processObservation(17, observation(2, {
      gameId: "f1-2025",
      sessionPhase: "finished",
      nativeRaceControlCode: 3,
      terminalObserved: true,
      raceControlEvidence: "authoritative",
    }));
    const repeatedFinalClassification = coordinator.processObservation(17, observation(3, {
      gameId: "f1-2025",
      sessionPhase: "finished",
      nativeRaceControlCode: 3,
      terminalObserved: true,
      raceControlEvidence: "authoritative",
    }));

    expect(finalClassification.events.map(({ eventType }) => eventType)).toContain("session_ended");
    expect(repeatedFinalClassification.events.map(({ eventType }) => eventType)).not.toContain("session_ended");
  });

  test("ACC and AC Evo no-flag projections close authoritative cautions", () => {
    const games = [
      ["acc", accServerAdapter],
      ["ac-evo", acEvoServerAdapter],
    ] as const;

    for (const [gameId, adapter] of games) {
      const coordinator = new RaceEventCoordinator({ sessionId: 30 });
      const projector = new RaceEventSemanticProjector();
      const yellowPacket = packet(gameId, {
        TimestampMS: 1_000,
        IsRaceOn: 1,
        acc: { flagStatus: "yellow" } as never,
      });
      const yellowSemantic = projector.project(yellowPacket, 1_000);
      const caution = applyRaceEventSemanticProjection(
        adapter.toRaceEventObservation(yellowPacket, {
          receivedAtMs: 1_000,
          sourceSequences: [],
          semantic: yellowSemantic,
        }),
        yellowSemantic,
      );
      const nonePacket = packet(gameId, {
        TimestampMS: 1_001,
        IsRaceOn: 1,
        acc: { flagStatus: "none" } as never,
      });
      const noneSemantic = projector.project(nonePacket, 1_001);
      const green = applyRaceEventSemanticProjection(
        adapter.toRaceEventObservation(nonePacket, {
          receivedAtMs: 1_001,
          sourceSequences: [],
          semantic: noneSemantic,
        }),
        noneSemantic,
      );

      const opened = coordinator.processObservation(30, caution);
      const closed = coordinator.processObservation(30, green);

      expect(caution).toMatchObject({
        sessionPhase: "caution",
        cautionKind: "local-yellow",
        raceControlEvidence: "authoritative",
      });
      expect(green).toMatchObject({
        sessionPhase: "green",
        nativeRaceControlCode: "none",
        raceControlEvidence: "authoritative",
      });
      expect(opened.events.map(({ eventType }) => eventType)).toContain("caution_started");
      expect(closed.events.map(({ eventType }) => eventType)).toEqual(
        expect.arrayContaining(["caution_ended", "green_flag"]),
      );
    }
  });

  test("rejects invalid receivedAt before high-water or lifecycle mutation", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 17 });
    coordinator.processObservation(17, observation(1, {
      gameId: "f1-2025",
      sessionPhase: "caution",
      cautionKind: "safety-car",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }));
    expect(() => coordinator.processObservation(17, observation(2, {
      receivedAtMs: Number.NaN,
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }))).toThrow("receivedAtMs");
    const corrected = coordinator.processObservation(17, observation(2, {
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }));

    expect(corrected.events.map(({ eventType }) => eventType)).toContain("caution_ended");
  });

  test("finalizes early gap with original timeline anchors after epoch change", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 18 });
    coordinator.processObservation(18, observation(1, { lapNumber: 1 }));
    coordinator.processObservation(18, observation(2, { lapNumber: 1 }));
    coordinator.processObservation(18, observation(5, {
      lapNumber: 1,
      trackDistanceM: 50,
      trackDistancePct: 0.5,
    }), {
      sourceSequenceGapCandidates: [{
        sourceSequenceFamily: "iracing-session-tick",
        previousSequence: 2,
        currentSequence: 5,
        previousSourceTimeMs: 200,
        currentSourceTimeMs: 500,
        previousObservationIndex: 1,
        currentObservationIndex: 2,
      }],
    });
    coordinator.processObservation(18, observation(1, {
      lapNumber: 2,
      sourceTimeMs: 1_000,
    }), { reconnect: true });
    const events = coordinator.noteSourceSequenceFinalized({
      summary: {
        expectedCount: 5,
        observedCount: 3,
        totalMissingCount: 2,
        totalMissingFraction: 0.4,
        largestContiguousGapMs: 300,
        countMethod: "native-sequence",
      },
      gaps: [{
        sourceSequenceFamily: "iracing-session-tick",
        previousSequence: 2,
        currentSequence: 5,
        previousSourceTimeMs: 200,
        currentSourceTimeMs: 500,
        previousObservationIndex: 1,
        currentObservationIndex: 2,
        durationMs: 300,
        missingCount: 2,
        countMethod: "native-sequence",
      }],
      duplicates: [],
      outOfOrder: [],
      inferredIntervalMs: null,
    });

    expect(events[0]).toMatchObject({
      timelineEpoch: 0,
      sequence: 3,
      lapNumber: 1,
      trackDistanceM: 50,
      trackDistancePct: 0.5,
    });
  });

  test("rejects invalid lifecycle-closing draft inputs before detector mutation", () => {
    let validCreatedAt = true;
    const coordinator = new RaceEventCoordinator({
      sessionId: 19,
      createdAt: () => validCreatedAt ? "2025-01-01T00:00:00.000Z" : "not-a-date",
    });
    coordinator.processObservation(19, observation(1, {
      gameId: "f1-2025",
      sessionPhase: "caution",
      cautionKind: "safety-car",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }));
    validCreatedAt = false;
    expect(() => coordinator.processObservation(19, observation(2, {
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }))).toThrow("createdAt");
    validCreatedAt = true;
    const corrected = coordinator.processObservation(19, observation(2, {
      gameId: "f1-2025",
      sessionPhase: "green",
      nativeRaceControlCode: 1,
      raceControlEvidence: "authoritative",
    }));

    expect(corrected.events.map(({ eventType }) => eventType)).toContain("caution_ended");
  });


  test("links same-observation pit stall arrival and service to staged pit entry", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 20 });
    coordinator.processObservation(20, observation(1));

    const result = coordinator.processObservation(20, observation(2, {
      participants: [participant({ pitState: "pit-stall", speedMps: 0 })],
    }));
    const pitEntry = result.events.find(({ eventType }) => eventType === "pit_entry")!;
    const arrival = result.events.find(({ eventType }) => eventType === "pit_stall_arrival")!;
    const service = result.events.find(({ eventType }) => eventType === "pit_service_started")!;

    expect(arrival).toMatchObject({
      lifecycleId: pitEntry.lifecycleId,
      linkedEventId: pitEntry.eventId,
    });
    expect(service).toMatchObject({
      lifecycleId: pitEntry.lifecycleId,
      linkedEventId: pitEntry.eventId,
    });
  });

  test("orders same-observation pit service start, actions, then completion", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 22 });
    const materialize = (coordinator as unknown as CoordinatorMaterializer).materializeDrafts.bind(coordinator);
    const base = {
      detectorId: "pit-service",
      detectorVersion: "test",
      boundaryKey: "same-observation-service",
      participant: participant(),
      evidenceKind: "derived",
      confidence: "high",
      qualityState: "available",
    };
    const events = materialize([
      { ...base, eventType: "repair_service_observed", payload: { previousComponents: {}, currentComponents: {}, repairedComponents: [] }, priority: 60 },
      { ...base, eventType: "pit_service_completed", payload: { durationMs: 1, observedActions: ["repair"], state: "pit-stall" }, priority: 50 },
      { ...base, eventType: "pit_service_started", payload: { trigger: "service-observation" }, priority: 60 },
      { ...base, eventType: "fuel_service_observed", payload: { beforeLitres: 1, afterLitres: 2, addedLitres: 1 }, priority: 60 },
    ] as DetectorEventDraft[], observation(1), 0, 1).events;

    expect(events.map(({ eventType }) => eventType)).toEqual([
      "pit_service_started",
      "fuel_service_observed",
      "repair_service_observed",
      "pit_service_completed",
    ]);
  });

  test("rolls lifecycle and emitted IDs back when any materialized draft is invalid", () => {
    const coordinator = new RaceEventCoordinator({ sessionId: 21 });
    // Private test seam: exercise batch commit without mutating detector state.
    const internals = coordinator as unknown as CoordinatorMaterializer;
    const materialize = internals.materializeDrafts.bind(coordinator);
    const opening = {
      eventType: "caution_started",
      payload: { kind: "safety-car", nativeCode: null },
      detectorId: "test",
      detectorVersion: "1",
      priority: 0,
      boundaryKey: "opening",
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
    } satisfies DetectorEventDraft<"caution_started">;
    const invalid = {
      eventType: "storage_failure",
      payload: { operation: "", details: null },
      detectorId: "test",
      detectorVersion: "1",
      priority: 10,
      boundaryKey: "invalid",
      evidenceKind: "observed",
      confidence: "high",
      qualityState: "available",
    } as DetectorEventDraft;
    const currentObservation = observation(1);

    const rejected = materialize([opening, invalid], currentObservation, 0, 1);
    expect(rejected.events).toEqual([]);
    expect(rejected.rejectedDrafts.map(({ eventType }) => eventType)).toEqual([
      "storage_failure",
    ]);

    const opened = materialize([opening], currentObservation, 0, 1).events;
    const closing = {
      ...opening,
      eventType: "caution_ended",
      boundaryKey: "closing",
    } satisfies DetectorEventDraft<"caution_ended">;
    const closed = materialize([closing], currentObservation, 0, 1).events;

    expect(opened).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      lifecycleId: opened[0]!.lifecycleId,
      linkedEventId: opened[0]!.eventId,
    });
  });
});
