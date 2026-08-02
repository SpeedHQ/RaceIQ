import { describe, expect, test } from "bun:test";
import { releaseFeatureFlags } from "../shared/release-feature-flags";

function loadReleaseEnvironment(path: string) {
  const process = Bun.spawnSync({
    cmd: [
      "bun",
      `--env-file=${path}`,
      "-e",
      'process.stdout.write(JSON.stringify({ RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS, RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER }))',
    ],
    cwd: import.meta.dir,
  });
  expect(process.exitCode).toBe(0);
  return JSON.parse(process.stdout.toString());
}

describe("release feature flags", () => {
  const developmentEnv = {
    RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
    RACEIQ_FEATURE_IRACING_ADAPTER: "true",
  };
  const productionEnv = {
    RACEIQ_FEATURE_F1_EXPERIMENTS: "false",
    RACEIQ_FEATURE_IRACING_ADAPTER: "false",
  };

  test("parses enabled development flags", () => {
    expect(releaseFeatureFlags(developmentEnv)).toEqual({
      f1Experiments: true,
      iracingAdapter: true,
    });
  });

  test("parses disabled production flags", () => {
    expect(releaseFeatureFlags(productionEnv)).toEqual({
      f1Experiments: false,
      iracingAdapter: false,
    });
  });

  test("loads enabled flags from the committed development environment", () => {
    expect(releaseFeatureFlags(loadReleaseEnvironment("../.env.development"))).toEqual({
      f1Experiments: true,
      iracingAdapter: true,
    });
  });

  test("loads disabled flags from the committed production environment", () => {
    expect(releaseFeatureFlags(loadReleaseEnvironment("../.env.production"))).toEqual({
      f1Experiments: false,
      iracingAdapter: false,
    });
  });

  test("rejects missing flags with the variable name", () => {
    expect(() =>
      releaseFeatureFlags({
        ...developmentEnv,
        RACEIQ_FEATURE_F1_EXPERIMENTS: undefined,
      }),
    ).toThrow("RACEIQ_FEATURE_F1_EXPERIMENTS");
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
