import { registerServerGame } from "./registry";
import { registerGame } from "../../shared/games/registry";
import { forzaServerAdapter } from "./fm-2023";
import { f1ServerAdapter } from "./f1-2025";
import { accServerAdapter } from "./acc";
import { acEvoServerAdapter } from "./ac-evo";
import { iracingServerAdapter } from "./iracing";
import { lmuServerAdapter } from "./lmu";
import { releaseFeatureFlags, type ReleaseFeatureFlags } from "../../shared/platform/runtime/release-feature-flags";

export function nativeTelemetryGameIds(
  flags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
    RACEIQ_FEATURE_LMU_ADAPTER: process.env.RACEIQ_FEATURE_LMU_ADAPTER,
  }),
) {
  const gameIds = ["acc", "ac-evo"] as const;
  if (flags.iracingAdapter && flags.lmuAdapter) {
    return [...gameIds, "iracing", "lmu"] as const;
  }
  if (flags.iracingAdapter) return [...gameIds, "iracing"] as const;
  if (flags.lmuAdapter) return [...gameIds, "lmu"] as const;
  return gameIds;
}

export function serverGameAdaptersForFeatures(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
    RACEIQ_FEATURE_LMU_ADAPTER: process.env.RACEIQ_FEATURE_LMU_ADAPTER,
  }),
) {
  const adapters = [
    f1ServerAdapter,
    forzaServerAdapter,
    accServerAdapter,
    acEvoServerAdapter,
  ];
  if (flags.iracingAdapter) adapters.push(iracingServerAdapter);
  if (flags.lmuAdapter) adapters.push(lmuServerAdapter);
  return adapters;
}

/** Register server game adapters. Call once at server startup. */
export function initServerGameAdapters(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
    RACEIQ_FEATURE_LMU_ADAPTER: process.env.RACEIQ_FEATURE_LMU_ADAPTER,
  }),
): void {
  for (const adapter of serverGameAdaptersForFeatures(flags)) {
    registerServerGame(adapter);
    // Server adapters override shared stub name-resolution methods.
    registerGame(adapter);
  }
}
