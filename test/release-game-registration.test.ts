import { describe, expect, test } from "bun:test";
import { gameAdaptersForFeatures } from "../shared/games/init";
import { releaseFeatureFlags } from "../shared/release-feature-flags";
import { nativeTelemetryGameIds, serverGameAdaptersForFeatures } from "../server/games/init";

const ids = (adapters: readonly { id: string }[]) => adapters.map((adapter) => adapter.id);

describe("release game registration", () => {
  test("includes iRacing in development registries", () => {
    const flags = releaseFeatureFlags(true);
    expect(ids(gameAdaptersForFeatures(flags))).toContain("iracing");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("iracing");
  });

  test("omits iRacing from production registries while keeping F1", () => {
    const flags = releaseFeatureFlags(false);
    expect(ids(gameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(serverGameAdaptersForFeatures(flags))).not.toContain("iracing");
    expect(ids(gameAdaptersForFeatures(flags))).toContain("f1-2025");
    expect(ids(serverGameAdaptersForFeatures(flags))).toContain("f1-2025");
  });

  test("lists native telemetry game ids by release environment", () => {
    expect(nativeTelemetryGameIds(releaseFeatureFlags(true))).toEqual(["acc", "ac-evo", "iracing"]);
    expect(nativeTelemetryGameIds(releaseFeatureFlags(false))).toEqual(["acc", "ac-evo"]);
  });
});
