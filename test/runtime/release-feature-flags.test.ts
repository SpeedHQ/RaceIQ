import { describe, expect, test } from "bun:test";
import { releaseFeatureFlags } from "../../shared/platform/runtime/release-feature-flags";

function loadReleaseEnvironment(path: string) {
  const env = { ...process.env };
  delete env.RACEIQ_FEATURE_F1_EXPERIMENTS;
  delete env.RACEIQ_FEATURE_IRACING_ADAPTER;
  delete env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER;
  delete env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS;
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      `--env-file=${path}`,
      "-e",
      'process.stdout.write(JSON.stringify({ RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS, RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS }))',
    ],
    cwd: import.meta.dir,
    env,
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

describe("release feature flags", () => {
  const developmentEnv = {
    RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
    RACEIQ_FEATURE_IRACING_ADAPTER: "true",
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: "true",
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: " acc, acc ",
  };
  const productionEnv = {
    RACEIQ_FEATURE_F1_EXPERIMENTS: "false",
    RACEIQ_FEATURE_IRACING_ADAPTER: "false",
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: "false",
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: "acc",
  };

  test("parses strict boolean and trimmed deduplicated game CSV", () => {
    expect(releaseFeatureFlags(developmentEnv)).toMatchObject({
      liveSpotterEngineer: true,
      liveSpotterEngineerGameIds: ["acc"],
    });
  });

  test("rejects non-boolean spotter flag and unsupported game IDs", () => {
    expect(() => releaseFeatureFlags({ ...developmentEnv, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: "yes" })).toThrow("RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER");
    expect(() => releaseFeatureFlags({ ...developmentEnv, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: "f1-2025" })).toThrow("RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS");
  });

  test("parses disabled production flags", () => {
    expect(releaseFeatureFlags(productionEnv)).toEqual({
      f1Experiments: false,
      iracingAdapter: false,
      liveSpotterEngineer: false,
      liveSpotterEngineerGameIds: ["acc"],
    });
  });

  test("loads committed development and production spotter values", () => {
    expect(releaseFeatureFlags(loadReleaseEnvironment("../../.env.development"))).toMatchObject({ liveSpotterEngineer: true, liveSpotterEngineerGameIds: ["acc"] });
    expect(releaseFeatureFlags(loadReleaseEnvironment("../../.env.production"))).toMatchObject({ liveSpotterEngineer: false, liveSpotterEngineerGameIds: ["acc"] });
  });

  test("loads disabled flags from the committed production environment", () => {
    expect(releaseFeatureFlags(loadReleaseEnvironment("../../.env.production"))).toEqual({
      f1Experiments: false,
      iracingAdapter: false,
      liveSpotterEngineer: false,
      liveSpotterEngineerGameIds: ["acc"],
    });
  });

  test("loads development flags for direct Bun tools", async () => {
    const { developmentReleaseFeatures } = await import("../../scripts/release/development-release-features");
    expect(developmentReleaseFeatures).toEqual({
      f1Experiments: true,
      iracingAdapter: true,
      liveSpotterEngineer: true,
      liveSpotterEngineerGameIds: ["acc"],
    });
  });

  test("defaults missing flags to disabled", () => {
    expect(
      releaseFeatureFlags({
        ...developmentEnv,
        RACEIQ_FEATURE_F1_EXPERIMENTS: undefined,
      }),
    ).toEqual({
      f1Experiments: false,
      iracingAdapter: true,
      liveSpotterEngineer: true,
      liveSpotterEngineerGameIds: ["acc"],
    });
  });

  test("rejects malformed flags with the variable name", () => {
    expect(() =>
      releaseFeatureFlags({
        ...developmentEnv,
        RACEIQ_FEATURE_IRACING_ADAPTER: "yes",
      }),
    ).toThrow("RACEIQ_FEATURE_IRACING_ADAPTER");
  });
});
