import { describe, expect, test } from "bun:test";
import { repeatabilityStats, stintStats } from "../shared/racing/laps/stint-stats";
import type { LapMeta } from "../shared/racing/sessions/types";

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

const lap = (overrides: Partial<LapMeta> = {}): LapMeta => ({
  id: 1,
  sessionId: 1,
  lapNumber: 1,
  lapTime: 100,
  isValid: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("stintStats", () => {
  test("preserves valid, excluded, and out-lap curation", () => {
    const result = stintStats([
      lap({ id: 1, lapNumber: 1, lapTime: 90 }),
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

  test("keeps curated pools intact when out-lap dropping is disabled", () => {
    expect(stintStats([lap({ lapNumber: 7, lapTime: 100 }), lap({ id: 2, lapNumber: 8, lapTime: 110 })], { dropOutLap: false }).n).toBe(2);
  });
});
