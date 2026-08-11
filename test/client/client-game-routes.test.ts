import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "../../shared/games/init";
import {
  gameIdForRoutePrefix,
  parseOptionalNumber,
  routePrefixForGameId,
  setupEngineerGameIdForRoutePrefix,
  supportsGameFeature,
  validateAnalyseSearch,
  validateCompareSearch,
  validateSessionsSearch,
  validateTuneReviewSearch,
  validateTuneSearch,
} from "../../client/src/lib/game-routes";
import { releaseFeatureFlags } from "../../shared/platform/runtime/release-feature-flags";

const developmentEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
  RACEIQ_FEATURE_IRACING_ADAPTER: "true",
};
const productionEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "false",
  RACEIQ_FEATURE_IRACING_ADAPTER: "false",
};

initGameAdapters(releaseFeatureFlags(developmentEnv));

describe("game route helpers", () => {
  test("resolves every supported route prefix and game id", () => {
    expect(gameIdForRoutePrefix("fm23")).toBe("fm-2023");
    expect(gameIdForRoutePrefix("f125")).toBe("f1-2025");
    expect(gameIdForRoutePrefix("acc")).toBe("acc");
    expect(gameIdForRoutePrefix("ac-evo")).toBe("ac-evo");
    expect(gameIdForRoutePrefix("iracing")).toBe("iracing");
    expect(routePrefixForGameId("f1-2025")).toBe("f125");
    expect(routePrefixForGameId("unknown")).toBeUndefined();
    expect(gameIdForRoutePrefix("unknown")).toBeUndefined();
  });

  test("parses only finite numeric search values", () => {
    expect(parseOptionalNumber("42")).toBe(42);
    expect(parseOptionalNumber(3.5)).toBe(3.5);
    expect(parseOptionalNumber(" ")).toBeUndefined();
    expect(parseOptionalNumber("nope")).toBeUndefined();
    expect(parseOptionalNumber(Number.NaN)).toBeUndefined();
    expect(parseOptionalNumber(true)).toBeUndefined();
  });

  test("validates analysis search values", () => {
    expect(validateAnalyseSearch({ track: "12", car: 34, lap: "bad", cursor: "15", viz: "3d", ai: "1", ignored: "x" })).toEqual({
      track: 12,
      car: 34,
      lap: undefined,
      cursor: 15,
      viz: "3d",
      ai: 1,
    });
  });

  test("validates comparison search values", () => {
    expect(validateCompareSearch({ track: "12", carA: 34, carB: "35", lapA: "8", lapB: "9", cursor: "15", ai: "1", ignored: "x" })).toEqual({
      track: 12,
      carA: 34,
      carB: 35,
      lapA: 8,
      lapB: 9,
      cursor: 15,
      ai: 1,
    });
  });

  test("accepts only the imported sessions tab", () => {
    expect(validateSessionsSearch({ tab: "imported" })).toEqual({ tab: "imported" });
    expect(validateSessionsSearch({ tab: "other" })).toEqual({ tab: undefined });
  });

  test("validates experiment search values", () => {
    expect(validateTuneSearch({ session: "live", lap: "4", view: "s2" })).toEqual({ session: "live", lap: 4, view: "s2" });
    expect(validateTuneSearch({ session: "bad", lap: "", view: "s0" })).toEqual({ session: undefined, lap: undefined, view: undefined });
    expect(validateTuneSearch({ session: "3", view: "overview" })).toEqual({ session: 3, lap: undefined, view: "overview" });
    expect(validateTuneReviewSearch({ laps: "1,2", lap: "4", view: "track", versionId: "9" })).toEqual({
      laps: "1,2",
      lap: 4,
      view: "track",
      versionId: 9,
    });
    expect(validateTuneReviewSearch({ laps: 1, view: "s0", versionId: "bad" })).toEqual({
      laps: undefined,
      lap: undefined,
      view: undefined,
      versionId: undefined,
    });
  });

  test("gates F1 experiments by release environment", () => {
    const development = releaseFeatureFlags(developmentEnv);
    const production = releaseFeatureFlags(productionEnv);
    expect(supportsGameFeature("f125", "experiments", development)).toBe(true);
    expect(supportsGameFeature("f125", "experiments", production)).toBe(false);
    expect(setupEngineerGameIdForRoutePrefix("f125", development)).toBe("f1-2025");
    expect(setupEngineerGameIdForRoutePrefix("f125", production)).toBeUndefined();
    expect(supportsGameFeature("acc", "experiments", production)).toBe(true);
    expect(supportsGameFeature("ac-evo", "experiments", production)).toBe(true);
  });

  test("keeps feature support explicit", () => {
    expect(supportsGameFeature("iracing", "driver")).toBe(false);
    expect(supportsGameFeature("iracing", "experiments")).toBe(false);
    expect(supportsGameFeature("iracing", "raw")).toBe(true);
    expect(supportsGameFeature("ac-evo", "experiments")).toBe(true);
    expect(setupEngineerGameIdForRoutePrefix("f125", releaseFeatureFlags(developmentEnv))).toBe("f1-2025");
    expect(setupEngineerGameIdForRoutePrefix("iracing")).toBeUndefined();
    expect(supportsGameFeature("unknown", "raw")).toBe(false);
  });
});
