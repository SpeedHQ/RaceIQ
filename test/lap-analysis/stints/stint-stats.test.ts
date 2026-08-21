import { describe, expect, test } from "bun:test";
import { evaluateAllEligibility } from "../../../shared/racing/quality/policies";
import { qualityPackets, summarize } from "../../support/lap-analysis/quality-model";
import { repeatabilityStats, stintStats } from "../../../shared/racing/laps/stint-stats";
import { DEFAULT_LAP_CLASSIFICATION } from "../../../shared/racing/laps/classification";
import type { LapMeta } from "../../../shared/racing/sessions/types";
const TEST_SOURCE_GENERATION = `sha256:${"a".repeat(64)}`;

describe("repeatabilityStats", () => {
  test("returns null statistics when no values qualify", () => {
    expect(repeatabilityStats([])).toEqual({ n: 0, mean: null, sd: null, consistency: null });
  });

  test("returns mean but no spread for one value", () => {
    expect(repeatabilityStats([12.5])).toEqual({ n: 1, mean: 12.5, sd: null, consistency: null });
  });

  test("reports zero spread for repeated values", () => {
    expect(repeatabilityStats([10, 10, 10])).toEqual({ n: 3, mean: 10, sd: 0, consistency: 100 });
  });
  test("keeps finite extremes stable for equal and unequal values", () => {
    expect(repeatabilityStats([Number.MAX_VALUE, Number.MAX_VALUE])).toEqual({
      n: 2,
      mean: Number.MAX_VALUE,
      sd: 0,
      consistency: 100,
    });

    const result = repeatabilityStats([Number.MAX_VALUE, Number.MAX_VALUE / 2]);
    expect(result.n).toBe(2);
    expect(Number.isFinite(result.mean)).toBe(true);
    expect(Number.isFinite(result.sd)).toBe(true);
    expect(result.mean).toBe(Number.MAX_VALUE * 0.75);
    expect(result.sd).toBe(Number.MAX_VALUE * 0.25);
    expect(result.consistency).toBe(0);
  });

  test("uses population SD and calibrated consistency", () => {
    const result = repeatabilityStats([10, 10.1]);
    expect(result.n).toBe(2);
    expect(result.mean).toBe(10.05);
    expect(result.sd).toBeCloseTo(0.05);
    expect(result.consistency).toBeCloseTo(86.06965174);
  });

  test("filters non-finite and non-positive values", () => {
    const result = repeatabilityStats([10, 0, -2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 10.1]);
    expect(result.n).toBe(2);
    expect(result.mean).toBe(10.05);
    expect(result.sd).toBeCloseTo(0.05);
    expect(result.consistency).toBeCloseTo(86.06965174);
  });
});

const lap = (overrides: Partial<LapMeta> = {}): LapMeta => {
  const value: LapMeta = {
    id: 1,
    sessionId: 1,
    lapNumber: 1,
    lapTime: 100,
    isValid: true,
    phase: "flying",
    conditions: [],
    paceEligibility: "eligible",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  const summarized = summarize(qualityPackets(200), {
    lapTime: 10,
    structurallyValid: value.isValid,
    invalidReason: value.isValid ? null : (value.invalidReason ?? "invalid-lap"),
    classification: {
      phase: value.phase ?? DEFAULT_LAP_CLASSIFICATION.phase,
      conditions: value.conditions ?? DEFAULT_LAP_CLASSIFICATION.conditions,
      paceEligibility: value.paceEligibility ?? DEFAULT_LAP_CLASSIFICATION.paceEligibility,
    },
  });
  const quality = {
    ...summarized,
    provenance: {
      ...summarized.provenance,
      sourceGeneration: TEST_SOURCE_GENERATION,
      outputGeneration: `sha256:${value.id.toString(16).padStart(64, "0")}`,
    },
  };
  return {
    ...value,
    quality,
    eligibility: overrides.eligibility ?? evaluateAllEligibility(quality),
    qualityGeneration: quality.provenance.outputGeneration,
  };
};

describe("stintStats", () => {
  test("excludes invalid, manually excluded, and classified non-pace laps", () => {
    const result = stintStats([
      lap({ id: 1, lapNumber: 1, lapTime: 90, phase: "out", paceEligibility: "excluded" }),
      lap({ id: 2, lapNumber: 2, lapTime: 100 }),
      lap({ id: 3, lapNumber: 3, lapTime: 110, isValid: false }),
      lap({ id: 4, lapNumber: 4, lapTime: 120, experimentExcluded: true }),
      lap({ id: 5, lapNumber: 5, lapTime: 105 }),
    ]);

    expect(result.n).toBe(2);
    expect(result.bestS).toBe(100);
    expect(result.meanS).toBe(102.5);
    expect(result.sdS).toBeCloseTo(2.5);
    expect(result.consistency).toBeCloseTo(31.70731707);
    expect(result.degSlopeSPerLap).toBeUndefined();
  });

  test("does not infer out lap from lap number", () => {
    expect(stintStats([lap({ lapNumber: 7, lapTime: 100 }), lap({ id: 2, lapNumber: 8, lapTime: 110 })]).n).toBe(2);
  });

  test("requires explicit pace segment before reporting degradation", () => {
    const laps = [lap({ id: 1, lapNumber: 1, lapTime: 100 }), lap({ id: 2, lapNumber: 2, lapTime: 101 }), lap({ id: 3, lapNumber: 3, lapTime: 102 })];
    const withoutSegment = stintStats(laps);
    const withSegment = stintStats(laps, "pace-segment-1");

    expect(withoutSegment.degSlopeSPerLap).toBeUndefined();
    expect(withoutSegment.falloffEligibility).toMatchObject({ status: "unknown", reasons: [{ code: "pace_segment_missing" }] });
    expect(withSegment.degSlopeSPerLap).toBeCloseTo(1);
    expect(withSegment.falloffEligibility.status).toBe("eligible");
  });
});
