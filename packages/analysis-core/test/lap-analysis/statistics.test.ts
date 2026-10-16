import { describe, expect, test } from "bun:test";
import { consistencyRating, populationVariance, stddevPopulation } from "@raceiq/analysis-core/racing/analysis/laps/statistics";

describe("lap statistics", () => {
  test("computes population variance and standard deviation", () => {
    expect(populationVariance([])).toBe(0);
    expect(populationVariance([1, 2, 3])).toBeCloseTo(2 / 3);
    expect(stddevPopulation([1, 2, 3])).toBeCloseTo(Math.sqrt(2 / 3));
  });

  test("rates consistency at exact cutoffs", () => {
    expect(consistencyRating(0, 100)).toBe(5);
    expect(consistencyRating(1, 100)).toBe(4);
    expect(consistencyRating(2, 100)).toBe(3);
    expect(consistencyRating(4, 100)).toBe(2);
    expect(consistencyRating(7, 100)).toBe(1);
    expect(consistencyRating(0, 0)).toBe(1);
  });
});
