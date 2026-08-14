import { describe, test, expect } from "bun:test";
import {
  selectCleanLaps,
  computeConsistency,
  aggregateSymptoms,
  baselineFallbackNote,
} from "../../server/experiments/lap-evidence/aggregate";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";
import type { LapMeta } from "../../shared/racing/sessions/types";
import type { TuneSymptoms } from "../../server/ai/tune-symptoms";

function lap(overrides: Partial<LapMeta> & { id: number }): LapMeta {
  return {
    sessionId: 1,
    lapNumber: overrides.id,
    lapTime: 90,
    isValid: true,
    createdAt: "2026-07-15T12:00:00.000Z",
    experimentId: 1,
    experimentVersionId: 1,
    experimentExcluded: false,
    ...overrides,
    phase: overrides.phase ?? DEFAULT_LAP_CLASSIFICATION.phase,
    conditions: overrides.conditions ?? DEFAULT_LAP_CLASSIFICATION.conditions,
    paceEligibility: overrides.paceEligibility ?? DEFAULT_LAP_CLASSIFICATION.paceEligibility,
  };
}

describe("selectCleanLaps", () => {
  test("keeps tight laps clean, drops a blunder as auto-outlier", () => {
    const laps: LapMeta[] = [
      lap({ id: 1, lapTime: 90.0 }),
      lap({ id: 2, lapTime: 90.2 }),
      lap({ id: 3, lapTime: 90.1 }),
      lap({ id: 4, lapTime: 94.6 }), // best*1.05 — a blunder lap
    ];

    const { clean, breakdown } = selectCleanLaps(laps);

    const byId = new Map(breakdown.map((r) => [r.lapId, r]));
    expect(byId.get(1)?.reason).toBe("clean");
    expect(byId.get(2)?.reason).toBe("clean");
    expect(byId.get(3)?.reason).toBe("clean");
    expect(byId.get(4)?.reason).toBe("auto-outlier");
    expect(clean.map((l) => l.id).sort()).toEqual([1, 2, 3]);
  });

  test("marks a non-candidate lap as invalid", () => {
    const laps: LapMeta[] = [
      lap({ id: 1, lapTime: 90 }),
      lap({ id: 2, lapTime: 0, isValid: false }),
    ];

    const { clean, breakdown } = selectCleanLaps(laps);

    expect(breakdown.find((r) => r.lapId === 2)?.reason).toBe("invalid");
    expect(clean.map((l) => l.id)).toEqual([1]);
  });

  test("marks a experimentExcluded lap as user-excluded", () => {
    const laps: LapMeta[] = [
      lap({ id: 1, lapTime: 90 }),
      lap({ id: 2, lapTime: 90.1, experimentExcluded: true }),
    ];

    const { clean, breakdown } = selectCleanLaps(laps);

    expect(breakdown.find((r) => r.lapId === 2)?.reason).toBe("user-excluded");
    expect(clean.map((l) => l.id)).toEqual([1]);
  });

  test("emits one breakdown row per input lap, imported flag set from experimentVersionId", () => {
    const laps: LapMeta[] = [
      lap({ id: 1, lapTime: 90, experimentVersionId: null }),
      lap({ id: 2, lapTime: 90.1, experimentVersionId: 5 }),
    ];

    const { breakdown } = selectCleanLaps(laps);

    expect(breakdown.length).toBe(2);
    expect(breakdown.find((r) => r.lapId === 1)?.imported).toBe(true);
    expect(breakdown.find((r) => r.lapId === 2)?.imported).toBe(false);
  });
});

describe("computeConsistency", () => {
  test("3 tight laps (spreadPct < 0.01) -> high", () => {
    const laps: LapMeta[] = [
      lap({ id: 1, lapTime: 90.0 }),
      lap({ id: 2, lapTime: 90.2 }),
      lap({ id: 3, lapTime: 90.3 }), // spreadPct = 0.3/90 ≈ 0.0033
    ];

    const report = computeConsistency(laps, null, 0);

    expect(report.confidence).toBe("high");
    expect(report.cleanLapCount).toBe(3);
    expect(report.bestLapSec).toBe(90.0);
  });

  test("2 laps with spreadPct >= 0.02 -> low", () => {
    const laps: LapMeta[] = [
      lap({ id: 1, lapTime: 90.0 }),
      lap({ id: 2, lapTime: 92.0 }), // spreadPct ≈ 0.022
    ];

    const report = computeConsistency(laps, null, 0);

    expect(report.confidence).toBe("low");
    expect(report.cleanLapCount).toBe(2);
  });

  test("single clean lap -> very-low", () => {
    const laps: LapMeta[] = [lap({ id: 1, lapTime: 90.0 })];

    const report = computeConsistency(laps, null, 0);

    expect(report.confidence).toBe("very-low");
    expect(report.cleanLapCount).toBe(1);
    expect(report.cornerConsistency).toBeNull();
  });

  test("no clean laps -> very-low with null stats", () => {
    const report = computeConsistency([], null, 0);

    expect(report.confidence).toBe("very-low");
    expect(report.bestLapSec).toBeNull();
    expect(report.spreadSec).toBeNull();
    expect(report.spreadPct).toBeNull();
  });
});

function tuneSymptoms(overrides: Partial<TuneSymptoms["aggregate"]>): TuneSymptoms {
  return {
    corners: [],
    aggregate: {
      balance: "neutral",
      understeerCorners: [],
      oversteerCorners: [],
      lockupCorners: [],
      bottomingCorners: [],
      tyrePressure: null,
      tyreTemp: null,
      damper: null,
      weightTransfer: null,
      ...overrides,
    },
  };
}

describe("aggregateSymptoms", () => {
  test("majority balance vote across laps", () => {
    const perLap = [
      tuneSymptoms({ balance: "understeer" }),
      tuneSymptoms({ balance: "understeer" }),
      tuneSymptoms({ balance: "oversteer" }),
    ];

    const result = aggregateSymptoms(perLap);

    expect(result.aggregate.balance).toBe("understeer");
  });

  test("tie in balance vote resolves to neutral", () => {
    const perLap = [
      tuneSymptoms({ balance: "understeer" }),
      tuneSymptoms({ balance: "oversteer" }),
    ];

    const result = aggregateSymptoms(perLap);

    expect(result.aggregate.balance).toBe("neutral");
  });

  test("corner appearing in >= ceil(n/2) laps is included", () => {
    // 3 laps, ceil(3/2) = 2 — "Turn 1" appears in 2/3, "Turn 2" in 1/3.
    const perLap = [
      tuneSymptoms({ understeerCorners: ["Turn 1"] }),
      tuneSymptoms({ understeerCorners: ["Turn 1", "Turn 2"] }),
      tuneSymptoms({ understeerCorners: [] }),
    ];

    const result = aggregateSymptoms(perLap);

    expect(result.aggregate.understeerCorners).toEqual(["Turn 1"]);
  });

  test("median tyrePressure across laps that report it", () => {
    const perLap = [
      tuneSymptoms({ tyrePressure: { FL: 1.0, FR: 1.0, RL: 1.0, RR: 1.0 } }),
      tuneSymptoms({ tyrePressure: { FL: 2.0, FR: 2.0, RL: 2.0, RR: 2.0 } }),
      tuneSymptoms({ tyrePressure: { FL: 3.0, FR: 3.0, RL: 3.0, RR: 3.0 } }),
      tuneSymptoms({ tyrePressure: null }), // does not report — excluded
    ];

    const result = aggregateSymptoms(perLap);

    expect(result.aggregate.tyrePressure).toEqual({ FL: 2.0, FR: 2.0, RL: 2.0, RR: 2.0 });
  });

  test("null tyrePressure when no lap reports it", () => {
    const perLap = [tuneSymptoms({}), tuneSymptoms({})];

    const result = aggregateSymptoms(perLap);

    expect(result.aggregate.tyrePressure).toBeNull();
  });
});

describe("baselineFallbackNote", () => {
  test("warns when the head test has zero own laps and we fell back to the session baseline", () => {
    const note = baselineFallbackNote({ sourceScope: "session-baseline", headOwnLapCount: 0 });
    expect(note).toContain("no laps recorded on this setup version");
    expect(note).toContain("session baseline");
  });

  test("silent when the branch pool was used", () => {
    expect(baselineFallbackNote({ sourceScope: "branch", headOwnLapCount: 5 })).toBeNull();
  });

  test("silent when there is no active head test", () => {
    expect(baselineFallbackNote({ sourceScope: "session-baseline", headOwnLapCount: null })).toBeNull();
  });

  test("silent when the head test has own laps (just not enough clean ones)", () => {
    expect(baselineFallbackNote({ sourceScope: "session-baseline", headOwnLapCount: 1 })).toBeNull();
  });
});
