import { describe, expect, test } from "bun:test";
import { hasSurfaceTemperatureProfile, tireTemperatureProfile, tireTemperatureReadings } from "../src/components/analyse/tire-temperature-profile";
import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";
import { lmuAdapter } from "../../shared/games/lmu";
import { analyseSemanticIds } from "../../shared/games/metric-contracts";

const frame = (values: Record<string, unknown>): SemanticAnalysisFrame => ({ values, states: {}, freshness: {} });

describe("tire temperature profile", () => {
  test("extracts profile and preserves missing bands", () => {
    const f = frame({
      "tire.temperature.surface.representative": [90, 91, 92, 93],
      "tire.temperature.surface.inner": [80, null, 82, 83],
      "tire.temperature.surface.middle": [90, 91, 92, 93],
      "tire.temperature.surface.outer": [100, 101, 102, 103],
      "tire.temperature.core": [85, 86, 87, 88],
    });
    expect(tireTemperatureProfile(f, 0)).toEqual({ representative: 90, inner: 80, middle: 90, outer: 100, core: 85 });
    expect(tireTemperatureProfile(f, 1).inner).toBeNull();
    expect(hasSurfaceTemperatureProfile(f)).toBe(true);
  });

  test("mirrors visual surface order by side", () => {
    const f = frame({
      "tire.temperature.surface.inner": [1, 2, 3, 4],
      "tire.temperature.surface.middle": [5, 6, 7, 8],
      "tire.temperature.surface.outer": [9, 10, 11, 12],
      "tire.temperature.core": [13, 14, 15, 16],
    });
    expect(tireTemperatureReadings(f, 0, "left", "tire.temperature.surface.representative", "surface").map((r) => r.kind)).toEqual(["outer", "middle", "inner", "core"]);
    expect(tireTemperatureReadings(f, 1, "right", "tire.temperature.surface.representative", "surface").map((r) => r.kind)).toEqual(["inner", "middle", "outer", "core"]);
  });

  test("falls back to representative and core without profile", () => {
    const f = frame({
      "tire.temperature.surface.representative": [90, 91, 92, 93],
      "tire.temperature.core": [85, null, 87, 88],
    });
    expect(hasSurfaceTemperatureProfile(f)).toBe(false);
    expect(tireTemperatureReadings(f, 0, "left", "tire.temperature.surface.representative", "surface")).toEqual([{ kind: "surface", value: 90 }, { kind: "core", value: 85 }]);
    expect(tireTemperatureReadings(f, 1, "left", "tire.temperature.surface.representative", "surface")).toEqual([{ kind: "surface", value: 91 }]);
  });

  test("LMU analysis separates surface bands from carcass without inventing core", () => {
    const ids = analyseSemanticIds(lmuAdapter);
    expect(ids).toEqual(expect.arrayContaining([
      "tire.temperature.surface.inner",
      "tire.temperature.surface.middle",
      "tire.temperature.surface.outer",
      "tire.temperature.carcass.representative",
    ]));
    const f = frame({
      "tire.temperature.surface.representative": [92, 93, 94, 95],
      "tire.temperature.surface.inner": [100, 81, 102, 83],
      "tire.temperature.surface.middle": [90, 91, 92, 93],
      "tire.temperature.surface.outer": [80, 101, 82, 103],
      "tire.temperature.carcass.representative": [85, 86, 87, 88],
    });
    expect(tireTemperatureReadings(f, 0, "left", "tire.temperature.surface.representative", "surface"))
      .toEqual([{ kind: "surface", value: 92 }, { kind: "outer", value: 80 }, { kind: "middle", value: 90 }, { kind: "inner", value: 100 }, { kind: "carcass", value: 85 }]);
    expect(tireTemperatureReadings(f, 1, "right", "tire.temperature.surface.representative", "surface"))
      .toEqual([{ kind: "surface", value: 93 }, { kind: "inner", value: 81 }, { kind: "middle", value: 91 }, { kind: "outer", value: 101 }, { kind: "carcass", value: 86 }]);
  });

  test("renders independent carcass and core readings when both are supplied", () => {
    const f = frame({
      "tire.temperature.surface.representative": [90, 91, 92, 93],
      "tire.temperature.carcass.representative": [84, 85, 86, 87],
      "tire.temperature.core": [80, 81, 82, 83],
    });
    expect(tireTemperatureReadings(f, 0, "left", "tire.temperature.surface.representative", "surface"))
      .toEqual([{ kind: "surface", value: 90 }, { kind: "carcass", value: 84 }, { kind: "core", value: 80 }]);
  });
});
