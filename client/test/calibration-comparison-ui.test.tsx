import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CalibrationComparisonSection } from "../src/components/track/debug/CalibrationComparisonSection";
import { transformCalibrationPath, type CalibrationComparison } from "../src/components/track/debug/calibration-comparison";

const comparison: CalibrationComparison = {
  calibrated: true,
  pointsCollected: 168,
  current: { scale: 1.02, rotation: Math.PI / 12, tx: 4.5, tz: -2.25 },
  history: [
    {
      sequence: 3,
      lapNumber: 7,
      transform: { scale: 1.01, rotation: Math.PI / 18, tx: 3, tz: -1 },
      rmse: 1.25,
      points: 84,
    },
  ],
};

describe("calibration comparison overlay", () => {
  test("applies calibration coordinates without an additional axis flip", () => {
    const transformed = transformCalibrationPath([{ x: 1, z: 2 }], {
      scale: 2,
      rotation: Math.PI / 2,
      tx: 10,
      tz: 20,
    });

    expect(transformed[0].x).toBeCloseTo(6);
    expect(transformed[0].z).toBeCloseTo(22);
  });

  test("renders an accessible history toggle and numeric fit legend", () => {
    const markup = renderToStaticMarkup(
      <CalibrationComparisonSection comparison={comparison} showHistory onShowHistoryChange={() => undefined} />,
    );

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('checked=""');
    expect(markup).toContain("Show historical fits");
    expect(markup).toContain("Current");
    expect(markup).toContain("1.020×");
    expect(markup).toContain("15.0°");
    expect(markup).toContain("Fit #3 · Lap 7");
    expect(markup).toContain("1.25 m RMSE");
    expect(markup).toContain("84 pts");
  });

  test("disables history toggle when no accepted fits exist", () => {
    const markup = renderToStaticMarkup(
      <CalibrationComparisonSection
        comparison={{ calibrated: false, pointsCollected: 12, current: null, history: [] }}
        showHistory={false}
        onShowHistoryChange={() => undefined}
      />,
    );

    expect(markup).toMatch(/<input[^>]*disabled=""/);
    expect(markup).toContain("No accepted calibration fits yet");
    expect(markup).toContain("12 points collected");
  });
});
