import { describe, expect, test } from "bun:test";
import { findTraceIndexAtDistance } from "../src/lib/comparison-utils";

describe("comparison trace cursor", () => {
  test("returns exact distance index", () => {
    expect(findTraceIndexAtDistance([0, 50, 75, 100], 75)).toBe(2);
  });

  test("returns nearest neighbour between distances", () => {
    expect(findTraceIndexAtDistance([0, 50, 100], 62)).toBe(1);
    expect(findTraceIndexAtDistance([0, 50, 100], 76)).toBe(2);
  });

  test("clamps before-first and after-last distances", () => {
    expect(findTraceIndexAtDistance([10, 20, 30], 0)).toBe(0);
    expect(findTraceIndexAtDistance([10, 20, 30], 40)).toBe(2);
  });

  test("returns -1 for empty distances", () => {
    expect(findTraceIndexAtDistance([], 10)).toBe(-1);
  });

  test("returns first duplicate index for exact duplicate distance", () => {
    expect(findTraceIndexAtDistance([0, 50, 50, 100], 50)).toBe(1);
  });
});
