import { registerGame } from "@raceiq/shared/games/registry";
import { releaseFeatureFlags, type ReleaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";
import { forzaAdapter } from "@raceiq/game-fm-2023-metadata/index";
import { f1Adapter } from "@raceiq/game-f1-2025-metadata/index";
import { accAdapter } from "@raceiq/game-acc-metadata/index";
import { acEvoAdapter } from "@raceiq/game-ac-evo-metadata/index";
import { iracingAdapter } from "@raceiq/game-iracing-metadata/index";
import { lmuAdapter } from "@raceiq/game-lmu-metadata/index";

export function gameAdaptersForFeatures(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  }),
) {
  const adapters = [forzaAdapter, f1Adapter, accAdapter, acEvoAdapter];
  if (flags.iracingAdapter) adapters.push(iracingAdapter);
  adapters.push(lmuAdapter);
  return adapters;
}

/** Register game adapters. Call once at app startup. */
export function initGameAdapters(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  }),
): void {
  for (const adapter of gameAdaptersForFeatures(flags)) registerGame(adapter);
}
