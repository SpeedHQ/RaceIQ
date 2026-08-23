import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../src/components/comparison/compare-ai-hooks", () => ({
  useComparisonAiSettings: () => ({ aiConfigured: true }),
  useLapAnalysis: () => ({ summary: null, loading: false, error: null, deleting: false, run: async () => {}, remove: async () => {} }),
  useInputsAnalysis: () => ({ analysis: null, loading: false, error: null, deleting: false, run: async () => {}, remove: async () => {} }),
  useAiRunAction: () => () => {},
}));
// Dynamic import is required so Bun installs hook mocks before module evaluation.

const { CompareAiPanel } = await import("../src/components/comparison/CompareAiPanel");

describe("multi-lap comparison AI", () => {
  test("offers lap analysis and reference-pair input analysis for every selected lap", () => {
    const markup = renderToStaticMarkup(
      createElement(CompareAiPanel, {
        laps: [
          { id: 1, label: "A — Reference", lapTime: 60_000 },
          { id: 2, label: "B — Qualifying", lapTime: 60_500 },
          { id: 3, label: "C — Race", lapTime: 61_000 },
        ],
        panelOpen: true,
      }),
    );

    expect(markup).toContain("A — Reference");
    expect(markup).toContain("B — Qualifying");
    expect(markup).toContain("C — Race");
    expect(markup).toContain("Inputs Comparison A ↔ B");
    expect(markup).toContain("Inputs Comparison A ↔ C");
    expect(markup.match(/Analyse Lap/g)).toHaveLength(3);
    expect(markup.match(/Compare Inputs/g)).toHaveLength(2);
  });
});
