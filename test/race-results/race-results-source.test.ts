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
  test("leaves pit and service strategy projection to the canonical timeline", () => {
    const result = extractRaceSource("acc", [
      packet({ acc: { pitStatus: "out", tireCompound: "dry", fuelPerLap: 2 } as never }),
      packet({ acc: { pitStatus: "pitlane", tireCompound: "dry", fuelPerLap: 2 } as never }),
      packet({ acc: { pitStatus: "out", tireCompound: "dry", fuelPerLap: 2 } as never }),
    ]);
    expect(result.tyreStrategy).toBeNull();
    expect(result.fuelStrategy).toBeNull();
    expect(result.evidence.fieldStatus.pitTimeline).toBe("unavailable");
    expect(result.evidence.fieldStatus.tyreStrategy).toBe("unavailable");
    expect(result.evidence.fieldStatus.fuelStrategy).toBe("unavailable");
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

  test("leaves position changes to the canonical timeline", () => {
    const result = extractRaceSource("f1-2025", [
      packet({ gameId: "f1-2025", LapNumber: 1, RacePosition: 5 }),
      packet({ gameId: "f1-2025", LapNumber: 1, RacePosition: 4 }),
      packet({ gameId: "f1-2025", LapNumber: 2, RacePosition: 4 }),
      packet({ gameId: "f1-2025", LapNumber: 2, RacePosition: 2 }),
      packet({ gameId: "f1-2025", LapNumber: 3, RacePosition: 3 }),
    ]);
    expect(Object.keys(result)).not.toContain("positionChanges");
  });

  test("does not invent a timeline for Forza", () => {
    expect(extractRaceSource("fm-2023", [packet({ gameId: "fm-2023" })]).evidence.fieldStatus.pitTimeline).toBe("unavailable");
  });
});
