import { describe, expect, test } from "bun:test";
import type { LapHeader } from "../src/components/comparison/compare-ai-types";
import { comparisonAiStateKey } from "../src/components/comparison/compare-ai-types";

function lap(id: number, qualityGeneration: string): LapHeader {
  return {
    id,
    label: `Lap ${id}`,
    lapTime: 90 + id,
    sessionId: 1,
    qualityGeneration,
    quality: {
      provenance: {
        schemaVersion: "1",
        policyVersion: "1",
        configurationVersion: "1",
        sourceGeneration: `source-${id}`,
        outputGeneration: qualityGeneration,
      },
    },
  } as LapHeader;
}

describe("comparison AI state identity", () => {
  test("changes when either lap quality generation changes", () => {
    const original = comparisonAiStateKey(lap(1, "quality-a1"), lap(2, "quality-b1"));

    expect(comparisonAiStateKey(lap(1, "quality-a2"), lap(2, "quality-b1"))).not.toBe(original);
    expect(comparisonAiStateKey(lap(1, "quality-a1"), lap(2, "quality-b2"))).not.toBe(original);
  });

  test("is stable when lap order is reversed", () => {
    expect(comparisonAiStateKey(lap(1, "quality-a1"), lap(2, "quality-b1"))).toBe(comparisonAiStateKey(lap(2, "quality-b1"), lap(1, "quality-a1")));
  });
});
