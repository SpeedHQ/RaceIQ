import { describe, expect, test } from "bun:test";
import { comparisonSearchPatch } from "../src/components/comparison/LapComparison";
import { COMPARISON_COLOR_VARS } from "../src/lib/colors";
import { comparisonLapIdentity, MAX_COMPARISON_LAPS, normalizeComparisonLapIds, planComparisonRequests, toggleComparisonLapSelection } from "../src/lib/comparison-utils";

describe("multi-lap comparison selection", () => {
  test("caps comparison laps to colors not used by reference lap", () => {
    let selectedLapIds: number[] = [];
    for (let lapId = 1; lapId <= MAX_COMPARISON_LAPS + 1; lapId++) {
      selectedLapIds = toggleComparisonLapSelection(selectedLapIds, lapId);
    }

    expect(selectedLapIds).toHaveLength(COMPARISON_COLOR_VARS.length - 1);
    expect(selectedLapIds).not.toContain(MAX_COMPARISON_LAPS + 1);
    expect(new Set([COMPARISON_COLOR_VARS[0], ...selectedLapIds.map((lapId) => comparisonLapIdentity(selectedLapIds, lapId)!.color)]).size).toBe(COMPARISON_COLOR_VARS.length);
  });

  test("preserves selected identity gaps when an earlier lap fails to load", () => {
    const selectedLapIds = [20, 30];

    expect(comparisonLapIdentity(selectedLapIds, 30)).toEqual({
      label: "C",
      color: COMPARISON_COLOR_VARS[2],
    });
  });

  test("requests only additions and aborts removed pending laps", () => {
    expect(planComparisonRequests([20, 30], new Set([20]), new Set(), new Set([40]))).toEqual({
      requestLapIds: [30],
      abortLapIds: [40],
    });
    expect(planComparisonRequests([20], new Set([20]), new Set(), new Set())).toEqual({
      requestLapIds: [],
      abortLapIds: [],
    });
  });

  test("normalizes shared URLs to unique non-reference laps within the palette", () => {
    expect(normalizeComparisonLapIds([10, 20, 20, 30, 40, 50, 60, 70, 80, 90], 10)).toEqual([20, 30, 40, 50, 60, 70, 80]);
  });

  test("keeps AI search state open for multiple comparison laps", () => {
    expect(
      comparisonSearchPatch({
        selectedTrack: 1,
        carAOrd: 2,
        lapAId: 10,
        comparisonLapIds: [20, 30],
        aiPanelOpen: true,
      }),
    ).toEqual({ track: 1, carA: 2, lapA: 10, laps: "20,30", ai: 1 });

    expect(
      comparisonSearchPatch({
        selectedTrack: 1,
        carAOrd: 2,
        lapAId: 10,
        comparisonLapIds: [20, 30],
        aiPanelOpen: false,
      }).ai,
    ).toBeUndefined();
  });
});
