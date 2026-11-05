import { describe, expect, test } from "bun:test";
import { parseLapAnalysisForDisplay } from "client/src/components/ai/analysis-display-data";

const analystJson = JSON.stringify({
  verdict: "Strong lap with time available in slow corners.",
  pace: [{ label: "Lap time", value: "79.328s", assessment: "warning", detail: "Several exits lose time." }],
  handling: [{ label: "Balance", value: "stable", assessment: "good", detail: "Car remains predictable." }],
  corners: [{ name: "Turn 5", issue: "Late rotation", fix: "Release brake earlier.", severity: "moderate" }],
  technique: [{ tip: "Earlier rotation", detail: "Carry more speed to apex." }],
  setup: [],
  actions: [
    { id: "a1", cornerKey: "Turn 5", label: "Turn 5", target: "solo", path: "corners[0].issue", span: { start: 0, end: 6 } },
    { id: "bad", cornerKey: "Turn 5", label: "Turn 5", target: "solo", path: 7, span: { start: 0, end: 6 } },
  ],
});

describe("lap analysis display parser", () => {
  test("normalizes analyst technique into coaching cards", () => {
    const result = parseLapAnalysisForDisplay(analystJson);

    expect(result).toMatchObject({
      verdict: "Strong lap with time available in slow corners.",
      coaching: [{ tip: "Earlier rotation", detail: "Carry more speed to apex." }],
      braking: [],
      throttle: [],
    });
  });

  test("keeps validated actions and drops malformed entries", () => {
    const result = parseLapAnalysisForDisplay(analystJson);
    expect(result?.actions).toHaveLength(1);
    expect(result?.actions?.[0]?.path).toBe("corners[0].issue");
  });

  test("rejects invalid JSON", () => {
    expect(parseLapAnalysisForDisplay("{not json")).toBeNull();
  });

  test("rejects incomplete analyst objects", () => {
    expect(parseLapAnalysisForDisplay(JSON.stringify({ verdict: "Only verdict" }))).toBeNull();
  });

  test("leaves regular Markdown on Markdown renderer path", () => {
    expect(parseLapAnalysisForDisplay("### Where it is bad\n- Turn 5 entry" )).toBeNull();
  });
});
