import { describe, test, expect } from "bun:test";
import { formatTuneForPrompt } from "../server/ai/format-tune";
import type { TuneSettings } from "../shared/types";

const SETTINGS: TuneSettings = {
  tires: { frontPressure: 30.5, rearPressure: 31.0, compound: "Sport" },
  gearing: { finalDrive: 3.42, ratios: [3.29, 2.16, 1.61, 1.27, 1.04, 0.88] },
  alignment: { frontCamber: -1.2, rearCamber: -0.8, frontToe: 0.0, rearToe: 0.1, frontCaster: 5.8 },
  antiRollBars: { front: 22.4, rear: 18.6 },
  springs: { frontRate: 750, rearRate: 680, frontHeight: 5.2, rearHeight: 5.4, unit: "lb/in" },
  damping: { frontRebound: 8.2, rearRebound: 7.4, frontBump: 5.1, rearBump: 4.8 },
  aero: { frontDownforce: 185, rearDownforce: 220, unit: "lb" },
  differential: { rearAccel: 72, rearDecel: 45 },
  brakes: { balance: 54, pressure: 95 },
};

describe("formatTuneForPrompt", () => {
  test("formats complete tune settings", () => {
    const result = formatTuneForPrompt({
      name: "Balanced Circuit v2",
      author: "acoop",
      category: "circuit",
      settings: SETTINGS,
    });
    expect(result).toContain("ACTIVE TUNE");
    expect(result).toContain("Balanced Circuit v2");
    expect(result).toContain("acoop");
    expect(result).toContain("30.5");
    expect(result).toContain("3.42");
    expect(result).toContain("-1.2");
    expect(result).toContain("22.4");
    expect(result).toContain("750");
    expect(result).toContain("8.2");
    expect(result).toContain("185");
    expect(result).toContain("72");
    expect(result).toContain("54");
  });

  test("handles missing optional fields gracefully", () => {
    const minimal: TuneSettings = {
      tires: { frontPressure: 30, rearPressure: 31 },
      gearing: { finalDrive: 3.5 },
      alignment: { frontCamber: -1, rearCamber: -1, frontToe: 0, rearToe: 0 },
      antiRollBars: { front: 20, rear: 20 },
      springs: { frontRate: 700, rearRate: 700, frontHeight: 5, rearHeight: 5 },
      damping: { frontRebound: 8, rearRebound: 8, frontBump: 5, rearBump: 5 },
      aero: { frontDownforce: 150, rearDownforce: 200 },
      differential: { rearAccel: 70, rearDecel: 40 },
      brakes: { balance: 50, pressure: 100 },
    };
    const result = formatTuneForPrompt({
      name: "Minimal",
      author: "test",
      category: "circuit",
      settings: minimal,
    });
    expect(result).toContain("Minimal");
    expect(result).not.toContain("undefined");
  });
});
