import { describe, expect, test } from "bun:test";
import { extractRaceSource } from "../server/race-results/source";
import type { TelemetryPacket } from "../shared/types";

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
  });

  test("does not invent pit ledger for Forza", () => {
    expect(extractRaceSource("fm-2023", [packet({ gameId: "fm-2023" })]).pitEvents).toBeUndefined();
  });
});
