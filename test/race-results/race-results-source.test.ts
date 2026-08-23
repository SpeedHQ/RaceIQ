import { describe, expect, test } from "bun:test";
import { RaceSourceAccumulator } from "../../server/race-results/source";
import type { RaceEventObservation } from "../../server/games/types";
import type { RaceResultSourceEvidence } from "../../server/race-results/types";
import type { RaceEvent } from "../../shared/racing/events/contracts";

const observation = (gameId: RaceEventObservation["gameId"], raceResult: RaceResultSourceEvidence): RaceEventObservation => ({
  gameId,
  sessionUid: null,
  receivedAtMs: 1,
  sourceTimeMs: 1,
  sourceSequences: [],
  lapNumber: null,
  currentLapTimeMs: null,
  lastLapTimeMs: null,
  trackDistanceM: null,
  trackDistancePct: null,
  worldPosition: null,
  sessionPhase: "unknown",
  nativeRaceControlCode: null,
  cautionKind: "unknown",
  gridStart: null,
  terminalObserved: null,
  raceResult,
  participants: [],
  rosterAuthoritative: false,
});

describe("race result source extraction", () => {
  test("leaves pit and service strategy projection to the canonical timeline", () => {
    const accumulator = new RaceSourceAccumulator("acc");
    accumulator.observe(observation("acc", { finishingPosition: 2, finishingPositionSource: "lap-data" }));
    const result = accumulator.finish();

    expect(result.tyreStrategy).toBeNull();
    expect(result.fuelStrategy).toBeNull();
    expect(result.evidence.fieldStatus.pitTimeline).toBe("unavailable");
    expect(result.evidence.fieldStatus.tyreStrategy).toBe("unavailable");
    expect(result.evidence.fieldStatus.fuelStrategy).toBe("unavailable");
  });

  test("preserves adapter-projected result classifications", () => {
    const dnf = new RaceSourceAccumulator("f1-2025");
    dnf.observe(
      observation("f1-2025", {
        classification: "dnf",
        classificationSource: "lap-data",
      }),
    );
    const retired = new RaceSourceAccumulator("f1-2025");
    retired.observe(
      observation("f1-2025", {
        classification: "retired",
        classificationSource: "lap-data",
      }),
    );

    expect(dnf.finish().classification).toBe("dnf");
    expect(retired.finish().classification).toBe("retired");
  });

  test("preserves direct disqualified and not-classified evidence", () => {
    const disqualified = new RaceSourceAccumulator("f1-2025");
    disqualified.observe(
      observation("f1-2025", {
        classification: "disqualified",
        classificationSource: "final-classification",
      }),
    );
    const notClassified = new RaceSourceAccumulator("f1-2025");
    notClassified.observe(
      observation("f1-2025", {
        classification: "not-classified",
        classificationSource: "final-classification",
      }),
    );

    expect(disqualified.finish().classification).toBe("disqualified");
    expect(disqualified.finish().evidence.fieldStatus.classification).toBe("direct");
    expect(notClassified.finish().classification).toBe("not-classified");
  });

  test("authoritative final classification supersedes provisional evidence", () => {
    const accumulator = new RaceSourceAccumulator("f1-2025");
    accumulator.observe(
      observation("f1-2025", {
        sessionType: "race",
        classification: "dnf",
        classificationSource: "lap-data",
        finishingPosition: 4,
        finishingPositionSource: "lap-data",
      }),
    );
    accumulator.observe(
      observation("f1-2025", {
        sessionType: "race",
        classification: "finished",
        classificationSource: "final-classification",
        finishingPosition: 1,
        finishingPositionSource: "final-classification",
      }),
    );
    const result = accumulator.finish();

    expect(result.classification).toBe("finished");
    expect(result.finishingPosition).toBe(1);
    expect(result.evidence.fieldStatus.classification).toBe("direct");
    expect(result.evidence.conflicts).toEqual([]);
    expect(result.claims?.map((claim) => [claim.authority, claim.value])).toEqual([
      ["simulator-live", "dnf"],
      ["simulator-final", "finished"],
    ]);
  });

  test("uses latest projected or stored timeline position", () => {
    const accumulator = new RaceSourceAccumulator("f1-2025");
    accumulator.observe(observation("f1-2025", { finishingPosition: 5, finishingPositionSource: "lap-data" }));
    accumulator.observe(observation("f1-2025", { finishingPosition: 4, finishingPositionSource: "lap-data" }));
    accumulator.observeEvent({
      eventType: "position_changed",
      participantKind: "player",
      payload: { previousPosition: 4, position: 3 },
    } as RaceEvent);

    expect(accumulator.finish().finishingPosition).toBe(3);
  });

  test("does not invent unavailable result evidence", () => {
    const result = new RaceSourceAccumulator("fm-2023").finish();

    expect(result.evidence.fieldStatus.pitTimeline).toBe("unavailable");
    expect(result.finishingPosition).toBeNull();
    expect("packets" in result).toBe(false);
  });

  test("retains early direct evidence without telemetry packets", () => {
    const accumulator = new RaceSourceAccumulator("f1-2025");
    for (let index = 0; index < 300; index++) {
      accumulator.observe(
        observation("f1-2025", {
          sessionType: "race",
          classification: "finished",
          classificationSource: "final-classification",
          finishingPosition: 2,
          finishingPositionSource: "final-classification",
          qualifyingPosition: 8,
          qualifyingPositionSource: "final-classification",
        }),
      );
    }
    const result = accumulator.finish();

    expect(result.classification).toBe("finished");
    expect(result.finishingPosition).toBe(2);
    expect(result.qualifyingPosition).toBe(8);
    expect("packets" in result).toBe(false);
  });
});
