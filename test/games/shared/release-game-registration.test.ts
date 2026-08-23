import { describe, expect, test } from "bun:test";
import { gameAdaptersForFeatures } from "../../../shared/games/init";
import { releaseFeatureFlags } from "../../../shared/platform/runtime/release-feature-flags";
import { initServerGameAdapters, nativeTelemetryGameIds, serverGameAdaptersForFeatures } from "../../../server/games/init";
import { getAllServerGames } from "../../../server/games/registry";

const ids = (adapters: readonly { id: string }[]) => adapters.map((adapter) => adapter.id);

const developmentEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
  RACEIQ_FEATURE_IRACING_ADAPTER: "true",
  RACEIQ_FEATURE_LMU_ADAPTER: "true",
};
const productionEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "false",
  RACEIQ_FEATURE_IRACING_ADAPTER: "false",
  RACEIQ_FEATURE_LMU_ADAPTER: "true",
};

describe("release game registration", () => {
  test("includes iRacing and LMU in development registries", () => {
    const flags = releaseFeatureFlags(developmentEnv);
    expect(ids(gameAdaptersForFeatures(flags))).toEqual(
      expect.arrayContaining(["iracing", "lmu"]),
    );
    expect(ids(serverGameAdaptersForFeatures(flags))).toEqual(
      expect.arrayContaining(["iracing", "lmu"]),
    );
  });

  test("keeps repeated server registration idempotent", () => {
    const flags = releaseFeatureFlags(developmentEnv);
    initServerGameAdapters(flags);
    initServerGameAdapters(flags);

    expect(ids(getAllServerGames())).toEqual(ids(serverGameAdaptersForFeatures(flags)));
  });

  test("ships LMU while keeping iRacing gated in production", () => {
    const flags = releaseFeatureFlags(productionEnv);
    expect(ids(gameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(gameAdaptersForFeatures(flags))).toContain("lmu");
    expect(ids(serverGameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("lmu");
    expect(ids(gameAdaptersForFeatures(flags))).toContain("f1-2025");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("f1-2025");
  });

  test("lists native telemetry game ids by release environment", () => {
    expect(nativeTelemetryGameIds(releaseFeatureFlags(developmentEnv))).toEqual(["acc", "ac-evo", "iracing", "lmu"]);
    expect(nativeTelemetryGameIds(releaseFeatureFlags(productionEnv))).toEqual(["acc", "ac-evo", "lmu"]);
  });
});
