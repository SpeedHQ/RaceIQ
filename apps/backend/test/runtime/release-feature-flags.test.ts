import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { describe, expect, test } from "bun:test";
import { isLiveEngineerSubsystemEnabled, releaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";

function loadReleaseEnvironment(path: string) {
  const env = { ...process.env };
  delete env.RACEIQ_FEATURE_F1_EXPERIMENTS;
  delete env.RACEIQ_FEATURE_IRACING_ADAPTER;
  delete env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER;
  delete env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS;
  delete env.RACEIQ_FEATURE_AMS2_ADAPTER;
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      `--env-file=${path}`,
      "-e",
      'process.stdout.write(JSON.stringify({ RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS, RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER, RACEIQ_FEATURE_AMS2_ADAPTER: process.env.RACEIQ_FEATURE_AMS2_ADAPTER, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS }))',
    ],
    cwd: ROOT_DIR,
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
    RACEIQ_FEATURE_AMS2_ADAPTER: "true",
  };
  const productionEnv = {
    RACEIQ_FEATURE_F1_EXPERIMENTS: "false",
    RACEIQ_FEATURE_IRACING_ADAPTER: "true",
    RACEIQ_FEATURE_AMS2_ADAPTER: "true",
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: "false",
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: "acc",
  };

  test("parses strict boolean and trimmed deduplicated game CSV", () => {
    expect(releaseFeatureFlags(developmentEnv)).toMatchObject({
      f1Experiments: true,
      iracingAdapter: true,
      ams2Adapter: true,
      liveSpotterEngineer: true,
      liveSpotterEngineerGameIds: ["acc"],
    });
  });

  test("rejects non-boolean spotter flag and unsupported game IDs", () => {
    expect(() => releaseFeatureFlags({ ...developmentEnv, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: "yes" })).toThrow("RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER");
    expect(() => releaseFeatureFlags({ ...developmentEnv, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: "not-a-game" })).toThrow("RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS");
  });

  test("allows F1 opponent pace without enabling F1 positional spotter", () => {
    const flags = releaseFeatureFlags({ ...developmentEnv, RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: "f1-2025" });
    expect(isLiveEngineerSubsystemEnabled(flags, "f1-2025", "opponent-pace")).toBe(true);
    expect(isLiveEngineerSubsystemEnabled(flags, "f1-2025", "live-spotter")).toBe(false);
  });

  test("parses production rollout flags", () => {
    expect(releaseFeatureFlags(productionEnv)).toEqual({
      f1Experiments: false,
      iracingAdapter: true,
      liveSpotterEngineer: false,
      liveSpotterEngineerGameIds: ["acc"],
      ams2Adapter: true,
    });
  });

  test("loads committed development and production spotter values", () => {
    expect(releaseFeatureFlags(loadReleaseEnvironment(".env.development"))).toMatchObject({ liveSpotterEngineer: true, liveSpotterEngineerGameIds: ["acc"] });
    expect(releaseFeatureFlags(loadReleaseEnvironment(".env.production"))).toMatchObject({ liveSpotterEngineer: false, liveSpotterEngineerGameIds: ["acc"] });
  });
  test("loads enabled flags from the committed development environment", () => {
    expect(releaseFeatureFlags(loadReleaseEnvironment(".env.development"))).toMatchObject({
      f1Experiments: true,
      iracingAdapter: true,
      ams2Adapter: true,
    });
  });

  test("loads production rollout flags from committed environment", () => {
    expect(releaseFeatureFlags(loadReleaseEnvironment(".env.production"))).toEqual({
      f1Experiments: false,
      iracingAdapter: true,
      ams2Adapter: true,
      liveSpotterEngineer: false,
      liveSpotterEngineerGameIds: ["acc"],
    });
  });

  test("loads development flags for direct Bun tools", async () => {
    const { developmentReleaseFeatures } = await import("@raceiq/tooling-release/release/development-release-features");
    expect(developmentReleaseFeatures).toEqual({
      f1Experiments: true,
      iracingAdapter: true,
      liveSpotterEngineer: true,
      liveSpotterEngineerGameIds: ["acc"],
      ams2Adapter: true,
    });
  });

  test("defaults missing flags to disabled", () => {
    expect(
      releaseFeatureFlags({
        ...developmentEnv,
        RACEIQ_FEATURE_AMS2_ADAPTER: undefined,
      }),
    ).toEqual({
      f1Experiments: true,
      iracingAdapter: true,
      liveSpotterEngineer: true,
      liveSpotterEngineerGameIds: ["acc"],
      ams2Adapter: false,
    });
  });

  test("rejects malformed AMS2 flags with the variable name", () => {
    expect(() =>
      releaseFeatureFlags({
        ...developmentEnv,
        RACEIQ_FEATURE_AMS2_ADAPTER: "yes",
      }),
    ).toThrow("RACEIQ_FEATURE_AMS2_ADAPTER");
  });
});
