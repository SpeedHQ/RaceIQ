import { describe, expect, test } from "bun:test";
import type { SemanticTelemetrySample } from "@shared/racing/comparison/types";
import { resolveComparisonImageryLocalPositions, type Point } from "@/lib/comparison-utils";

const outline: Point[] = [
  { x: -10, z: 0 },
  { x: 0, z: 10 },
  { x: 10, z: 0 },
];

function sample(x: number, z: number): SemanticTelemetrySample {
  return {
    values: { "motion.position-x": x, "motion.position-z": z },
    sequence: "1",
    observedAtMs: 0,
  };
}

describe("Compare imagery local coordinates", () => {
  test("falls back to outline coordinates indexed to telemetry samples", () => {
    const local = resolveComparisonImageryLocalPositions([sample(0, 0), sample(0, 0)], outline);
    expect(local).toEqual([outline[0], outline[2]]);
  });

  test("falls back when most telemetry positions are missing", () => {
    const local = resolveComparisonImageryLocalPositions([sample(-1, 2), sample(0, 0), sample(0, 0), sample(0, 0), sample(4, 5)], outline);
    expect(local).toHaveLength(5);
    expect(local?.[0]).toEqual(outline[0]);
    expect(local?.at(-1)).toEqual(outline.at(-1));
  });

  test("keeps dense telemetry coordinates indexed with lap geographic positions", () => {
    expect(resolveComparisonImageryLocalPositions([sample(-1, 2), sample(0, 3), sample(4, 5)], outline)).toBeUndefined();
  });
});
