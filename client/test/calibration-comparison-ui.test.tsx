import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CalibrationComparisonSection, transformCalibrationPath } from "@raceiq/tracks-catalogue/ui";
import type { CalibrationComparison } from "@raceiq/tracks-catalogue/contracts";
import { TracksCatalogueHostProvider } from "../src/features/tracks-catalogue-host";

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
  test("maps outline coordinates into source space with the inverse calibration transform", () => {
    const transformed = transformCalibrationPath([{ x: 6, z: 22 }], {
      scale: 2,
      rotation: Math.PI / 2,
      tx: 10,
      tz: 20,
    });

    expect(transformed[0].x).toBeCloseTo(1);
    expect(transformed[0].z).toBeCloseTo(2);
  });
  test("renders an accessible history toggle and numeric fit legend", () => {
    const markup = renderToStaticMarkup(<TracksCatalogueHostProvider><CalibrationComparisonSection comparison={comparison} showHistory onShowHistoryChange={() => undefined} /></TracksCatalogueHostProvider>);

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('checked=""');
    expect(markup).toContain("1.020×");
    expect(markup).toContain("15.0°");
    expect(markup).toContain("1.25 m RMSE");
    expect(markup).toContain("84 pts");
  });

  test("disables history toggle when no accepted fits exist", () => {
    const markup = renderToStaticMarkup(
      <TracksCatalogueHostProvider><CalibrationComparisonSection comparison={{ calibrated: false, pointsCollected: 12, current: null, history: [] }} showHistory={false} onShowHistoryChange={() => undefined} /></TracksCatalogueHostProvider>,
    );

    expect(markup).toMatch(/<input[^>]*disabled=""/);
  });
});
