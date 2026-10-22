import { describe, expect, it } from "bun:test";
import { readERSDeployMode, buildERSModeRuns } from "../../ui/spectate-ers-mode"
import type { SpectateReading } from "../../contracts/spectate"

const reading = (value: unknown): SpectateReading => ({
  time: 0,
  distance: null,
  pose: null,
  values: { "fuel.ers-deploy-mode": value },
});

describe("readERSDeployMode", () => {
  it("accepts numeric and string mode values from the replay stream", () => {
    for (let mode = 0; mode <= 3; mode++) {
      expect(readERSDeployMode(reading(mode))).toBe(mode);
      expect(readERSDeployMode(reading(String(mode)))).toBe(mode);
    }
  });

  it("returns unavailable for missing or invalid mode values", () => {
    expect(readERSDeployMode(null)).toBeNull();
    expect(readERSDeployMode(reading(undefined))).toBeNull();
    for (const invalid of [-1, 4, 1.5, "", "04", "regen"]) {
      expect(readERSDeployMode(reading(invalid))).toBeNull();
    }
  });
});

describe("buildERSModeRuns", () => {
  const point = (time: number, a: unknown, b?: unknown) => ({ time, a: reading(a), b: b === undefined ? null : reading(b) });

  it("keeps numeric and string Hotlap samples in one continuous band", () => {
    expect(buildERSModeRuns([point(0, "2"), point(0.125, 2), point(0.25, "2"), point(0.5, 2)], "a"))
      .toEqual([{ start: 0, end: 0.5, mode: 2 }]);
  });

  it("retains exact mode changes and never bridges unavailable intervals", () => {
    expect(buildERSModeRuns([point(0, 2), point(1, 3), point(2, null), point(3, "3"), point(4, "3")], "a"))
      .toEqual([{ start: 0, end: 1, mode: 2 }, { start: 1, end: 2, mode: 3 }, { start: 3, end: 4, mode: 3 }]);
  });

  it("keeps lap B independent without inventing a band for an absent lap", () => {
    const points = [point(0, 2, 1), point(1, 2, 3), point(2, 2, 3)];
    expect(buildERSModeRuns(points, "b")).toEqual([{ start: 0, end: 1, mode: 1 }, { start: 1, end: 2, mode: 3 }]);
    expect(buildERSModeRuns([point(0, 2), point(1, 2)], "b")).toEqual([]);
  });

  it("does not extend a mode into a telemetry gap or beyond the recording", () => {
    expect(buildERSModeRuns([point(0, 2), point(1, 2), { time: 2, a: null, b: null }], "a"))
      .toEqual([{ start: 0, end: 1, mode: 2 }]);
  });
});
