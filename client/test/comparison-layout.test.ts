import { describe, expect, test } from "bun:test";
import { COMPARE_MAP_MAX_HEIGHT, COMPARE_MAP_MIN_HEIGHT, clampCompareMapHeight, clampCompareMapWidth } from "../src/lib/comparison-layout";

describe("comparison map sizing", () => {
  test("preserves a usable chart width while honoring the saved map width", () => {
    expect(clampCompareMapWidth(440, 1200, false)).toBe(440);
    expect(clampCompareMapWidth(700, 1000, false)).toBe(512);
  });

  test("reserves space for the AI sidebar when it is open", () => {
    expect(clampCompareMapWidth(440, 1200, true)).toBe(344);
    expect(clampCompareMapWidth(700, 1000, true)).toBe(280);
  });

  test("enforces the minimum map width", () => {
    expect(clampCompareMapWidth(100, 1200, false)).toBe(280);
  });

  test("bounds the stacked map height while preserving valid saved heights", () => {
    expect(clampCompareMapHeight(672)).toBe(672);
    expect(clampCompareMapHeight(100)).toBe(COMPARE_MAP_MIN_HEIGHT);
    expect(clampCompareMapHeight(2000)).toBe(COMPARE_MAP_MAX_HEIGHT);
  });
});
