import { describe, expect, test } from "bun:test";
import { suspensionCompressionBias } from "../../shared/racing/analysis/laps/physics/vehicle";

describe("suspension compression bias", () => {
  test("reports each axis as its share of total compression", () => {
    const bias = suspensionCompressionBias([0.06, 0.08, 0.18, 0.20]);
    expect(bias.front).toBeCloseTo(14 / 52);
    expect(bias.left).toBeCloseTo(24 / 52);
  });
});
