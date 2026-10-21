import { describe, expect, it } from "bun:test";
import { readERSDeployMode } from "../../ui/spectate-ers-mode"
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
