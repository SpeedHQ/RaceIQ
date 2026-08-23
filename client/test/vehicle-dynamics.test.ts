import { describe, expect, test } from "bun:test";
import { controlInputPercent } from "../src/lib/vehicle-dynamics";

describe("controlInputPercent", () => {
  test("converts and clamps canonical input ratios", () => {
    expect(controlInputPercent(0.42)).toBe(42);
    expect(controlInputPercent(-0.1)).toBe(0);
    expect(controlInputPercent(1.1)).toBe(100);
    expect(controlInputPercent(undefined)).toBe(0);
  });
});
