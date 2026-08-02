import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WheelTable } from "../src/components/analyse/WheelTable";
import { InsightPanel } from "../src/components/InsightPanel";
import type { LapInsight } from "../src/lib/lap-insights";

const insight: LapInsight = {
  id: "lockup-fl",
  category: "tires",
  severity: "warning",
  label: "Wheel Lockup",
  detail: "FL locked 1 time",
  frameIndices: [42],
};

describe("Analyse panel layout", () => {
  test("renders insight rows with content-sized plain buttons", () => {
    const markup = renderToStaticMarkup(createElement(InsightPanel, { insights: [insight], onJumpToFrame: () => {} }));

    expect(markup).toContain('data-slot="button"');
    expect(markup).toMatch(/<button[^>]*bg-transparent[^>]*h-auto/);
    expect(markup).not.toMatch(/<button[^>]*h-8/);
    expect(markup).not.toMatch(/<button[^>]*bg-app-surface-alt/);
  });

  test("centers wheel headers over their value columns", () => {
    const markup = renderToStaticMarkup(
      createElement(WheelTable, {
        title: "Wheels",
        rows: [{ label: "Temperature", fl: "86°C", fr: "85°C", rl: "83°C", rr: "82°C" }],
      }),
    );

    expect(markup).toMatch(/<th[^>]*text-center[^>]*><span>FL/);
    expect(markup).toMatch(/<th[^>]*text-center[^>]*><span>FR/);
    expect(markup).toMatch(/<th[^>]*text-center[^>]*><span>RL/);
    expect(markup).toMatch(/<th[^>]*text-center[^>]*><span>RR/);
  });
});
