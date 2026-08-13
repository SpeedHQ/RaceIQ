import { describe, expect, test } from "bun:test";
import { gameAdaptersForFeatures } from "../../../shared/games/init";
import { releaseFeatureFlags } from "../../../shared/platform/runtime/release-feature-flags";
import { initServerGameAdapters, nativeTelemetryGameIds, serverGameAdaptersForFeatures } from "../../../server/games/init";
import { getAllServerGames } from "../../../server/games/registry";

const ids = (adapters: readonly { id: string }[]) => adapters.map((adapter) => adapter.id);

const developmentEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "true",
  RACEIQ_FEATURE_IRACING_ADAPTER: "true",
};
const productionEnv = {
  RACEIQ_FEATURE_F1_EXPERIMENTS: "false",
  RACEIQ_FEATURE_IRACING_ADAPTER: "false",
};

describe("release game registration", () => {
  test("includes iRacing in development registries", () => {
    const flags = releaseFeatureFlags(developmentEnv);
    expect(ids(gameAdaptersForFeatures(flags))).toContain("iracing");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("iracing");
  });

  test("keeps repeated server registration idempotent", () => {
    const flags = releaseFeatureFlags(developmentEnv);
    initServerGameAdapters(flags);
    initServerGameAdapters(flags);

    expect(ids(getAllServerGames())).toEqual(ids(serverGameAdaptersForFeatures(flags)));
  });

  test("omits iRacing from production registries while keeping F1", () => {
    const flags = releaseFeatureFlags(productionEnv);
    expect(ids(gameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(serverGameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(gameAdaptersForFeatures(flags))).toContain("f1-2025");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("f1-2025");
  });

  test("lists native telemetry game ids by release environment", () => {
    expect(nativeTelemetryGameIds(releaseFeatureFlags(developmentEnv))).toEqual(["acc", "ac-evo", "iracing"]);
    expect(nativeTelemetryGameIds(releaseFeatureFlags(productionEnv))).toEqual(["acc", "ac-evo"]);
  });
});
