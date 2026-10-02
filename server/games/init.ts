import { registerServerGame } from "./registry";
import { registerGame } from "@raceiq/games/registry";
import { forzaServerAdapter } from "@raceiq/game-fm-2023/index";
import { f1ServerAdapter } from "@raceiq/game-f1-2025/index";
import { accServerAdapter } from "@raceiq/game-acc/index";
import { acEvoServerAdapter } from "@raceiq/game-ac-evo/index";
import { iracingServerAdapter } from "@raceiq/game-iracing/index";
import { lmuServerAdapter } from "@raceiq/game-lmu/index";
import { releaseFeatureFlags, type ReleaseFeatureFlags } from "../../shared/platform/runtime/release-feature-flags";

export function nativeTelemetryGameIds(
  flags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  }),
) {
  const gameIds = ["acc", "ac-evo"] as const;
  return flags.iracingAdapter
    ? [...gameIds, "iracing", "lmu"] as const
    : [...gameIds, "lmu"] as const;
}

export function serverGameAdaptersForFeatures(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  }),
) {
  const adapters = [
    f1ServerAdapter,
    forzaServerAdapter,
    accServerAdapter,
    acEvoServerAdapter,
  ];
  if (flags.iracingAdapter) adapters.push(iracingServerAdapter);
  adapters.push(lmuServerAdapter);
  return adapters;
}

/** Register server game adapters. Call once at server startup. */
export function initServerGameAdapters(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  }),
): void {
  for (const adapter of serverGameAdaptersForFeatures(flags)) {
    registerServerGame(adapter);
    // Server adapters override shared stub name-resolution methods.
    registerGame(adapter);
  }
}
