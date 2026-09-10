import { describe, expect, test } from "bun:test";
import { pixelAlignedCursorBBox } from "../src/components/TelemetryChart";

describe("TelemetryChart cursor marker geometry", () => {
  test.each([
    [10.49, 20.49],
    [10.5, 20.5],
    [10.51, 20.51],
    [-10.49, -20.49],
    [-10.51, -20.51],
    [-100.25, 1000.75],
  ])("centers 6 px marker on rounded coordinates (%p, %p)", (x, y) => {
    const bbox = pixelAlignedCursorBBox(x, y, 6);

    expect(bbox.left + bbox.width / 2).toBe(Math.round(x));
    expect(bbox.top + bbox.height / 2).toBe(Math.round(y));
    expect(bbox.width).toBe(6);
    expect(bbox.height).toBe(6);
  });
});
