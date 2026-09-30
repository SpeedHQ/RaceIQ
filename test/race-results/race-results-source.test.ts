import { describe, expect, test } from "bun:test";
import { extractRaceSource } from "../../server/race-results/source";
import { deriveRaceResult } from "../../server/race-results/derive";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const packet = (overrides: Partial<TelemetryPacket> = {}): TelemetryPacket => ({
  gameId: "acc",
  IsRaceOn: 1,
  TimestampMS: 1,
  CurrentRaceTime: 10,
  LapNumber: 4,
  RacePosition: 2,
  BestLap: 90,
  ...overrides,
} as TelemetryPacket);

describe("race result source extraction", () => {
  test("uses LMU session mode to distinguish practice timing rank from race position", () => {
    for (const sessionType of ["practice-1", "test-day", "race"]) {
      const source = extractRaceSource("lmu", [
        packet({ gameId: "lmu", LapNumber: 1, RacePosition: 3, lmu: { sessionType, inPits: false } as never }),
        packet({ gameId: "lmu", LapNumber: 2, RacePosition: 2, lmu: { sessionType, inPits: false } as never }),
      ]);
      expect(source.sessionType).toBe(sessionType);
      expect(source.provenance.fields?.sessionType).toBe("lmu.sessionType");
      const result = deriveRaceResult(source);
      if (sessionType === "race") {
        expect(result.finishingPosition).toBe(2);
        expect(result.events).toMatchObject([{ eventType: "position-change", positionBefore: 3, positionAfter: 2 }]);
      } else {
        expect(result.finishingPosition).toBeNull();
        expect(result.events).toEqual([]);
      }
    }
  });

  test("records ACC penalty changes once, resets after clearing, and preserves pit ordering", () => {
    const frame = (penalty: number, penaltyTime: number, pitStatus = "out") => packet({
      acc: { sessionType: "race", penalty, penaltyType: "stop-and-go-speeding", penaltyTime, pitStatus } as never,
    });
    const source = extractRaceSource("acc", [
      frame(0, 0), frame(7, 10), frame(7, 10), frame(7, 8),
      frame(7, 8, "in_pit"), frame(7, 10, "in_pit"),
      frame(0, 0), frame(7, 10), frame(7, 20),
    ]);
    const result = deriveRaceResult(source);
    expect(result.sessionType).toBe("race");
    expect(result.pitCount).toBe(1);
    expect(result.events.map((event) => event.eventType ?? "pit")).toEqual(["penalty", "pit", "penalty", "penalty"]);
    expect(result.events.filter((event) => event.eventType === "penalty").map((event) => event.source.penaltyTime)).toEqual([10, 10, 20]);
    expect(result.events[0]).toMatchObject({ lapNumber: 4, elapsedSeconds: 10, durationSeconds: null });
  });

  test("does not infer ACC penalties from flags or expose ACC-only penalties on AC Evo", () => {
    expect(extractRaceSource("acc", [packet({ acc: { flagStatus: "penalty" } as never })]).penalties).toEqual([]);
    expect(extractRaceSource("ac-evo", [packet({ gameId: "ac-evo", acc: { penalty: 7, penaltyTime: 10 } as never })]).penalties).toEqual([]);
  });

  test("extracts ACC pit transitions and explicit strategy values", () => {
    const result = extractRaceSource("acc", [
      packet({ acc: { pitStatus: "out", tireCompound: "dry", fuelPerLap: 2 } as never }),
      packet({ acc: { pitStatus: "pitlane", tireCompound: "dry", fuelPerLap: 2 } as never }),
      packet({ acc: { pitStatus: "out", tireCompound: "dry", fuelPerLap: 2 } as never }),
    ]);
    expect(result.pitEvents).toHaveLength(1);
    expect(result.pitEvents?.[0]?.service).toBe("unknown");
    expect(result.tyreStrategy).toBe("dry");
  });
  test("derives DNF and retired classifications from F1 result status", () => {
    const dnf = extractRaceSource("f1-2025", [
      packet({ gameId: "f1-2025", f1: { sessionType: "race", resultStatus: 4 } as never }),
    ]);
    const retired = extractRaceSource("f1-2025", [
      packet({ gameId: "f1-2025", f1: { sessionType: "race", resultStatus: 7 } as never }),
    ]);
    expect(dnf.classification).toBe("dnf");
    expect(retired.classification).toBe("retired");
  });

  test("preserves disqualified and not-classified F1 statuses", () => {
    const disqualified = extractRaceSource("f1-2025", [
      packet({ gameId: "f1-2025", f1: { sessionType: "race", resultStatus: 5, resultSource: "final-classification" } as never }),
    ]);
    const notClassified = extractRaceSource("f1-2025", [
      packet({ gameId: "f1-2025", f1: { sessionType: "race", resultStatus: 6, resultSource: "final-classification" } as never }),
    ]);
    expect(disqualified.classification).toBe("disqualified");
    expect(disqualified.evidence.fieldStatus.classification).toBe("direct");
    expect(notClassified.classification).toBe("not-classified");
  });

  test("authoritative final classification supersedes provisional lap status", () => {
    const result = extractRaceSource("f1-2025", [
      packet({
        gameId: "f1-2025",
        f1: { sessionType: "race", resultStatus: 4, resultSource: "lap-data" } as never,
      }),
      packet({
        gameId: "f1-2025",
        RacePosition: 1,
        f1: { sessionType: "race", resultStatus: 3, resultSource: "final-classification" } as never,
      }),
    ]);

    expect(result.classification).toBe("finished");
    expect(result.finishingPosition).toBe(1);
    expect(result.evidence.fieldStatus.classification).toBe("direct");
    expect(result.evidence.conflicts).toEqual([]);
    expect(result.claims?.map((claim) => [claim.authority, claim.value])).toEqual([
      ["simulator-live", "dnf"],
      ["simulator-final", "finished"],
    ]);
    expect(result.claims?.every((claim) =>
      claim.claimId === "race-result.classification" &&
      claim.entityId === "f1-2025:player" &&
      claim.kind === "deterministic" &&
      claim.valid &&
      claim.applicable &&
      claim.validated &&
      claim.provenance === result.provenance
    )).toBe(true);
    expect(result.provenance.authorityPolicyId).toBe("race-result-outcome-authority");
    const derived = deriveRaceResult(result);
    expect(derived.classification).toBe("finished");
    expect(derived.outcomeStatus).toBe("confirmed");
    expect(derived.evidence.decisions?.classification.alternatives.map((alternative) => alternative.value)).toEqual(["finished", "dnf"]);
  });

  test("consolidates position changes at lap boundaries", () => {
    const result = extractRaceSource("f1-2025", [
      packet({ gameId: "f1-2025", LapNumber: 1, RacePosition: 5 }),
      packet({ gameId: "f1-2025", LapNumber: 1, RacePosition: 4 }),
      packet({ gameId: "f1-2025", LapNumber: 2, RacePosition: 4 }),
      packet({ gameId: "f1-2025", LapNumber: 2, RacePosition: 2 }),
      packet({ gameId: "f1-2025", LapNumber: 3, RacePosition: 3 }),
    ]);
    expect(result.positionChanges).toMatchObject([
      { lapNumber: 2, positionBefore: 4, positionAfter: 2 },
      { lapNumber: 3, positionBefore: 2, positionAfter: 3 },
    ]);
  });

  test("does not invent pit ledger for Forza", () => {
    expect(extractRaceSource("fm-2023", [packet({ gameId: "fm-2023" })]).pitEvents).toBeUndefined();
  });
});
