import { registerGame } from "./registry";
import { forzaAdapter } from "./fm-2023";
import { f1Adapter } from "./f1-2025";
import { accAdapter } from "./acc";
import { acEvoAdapter } from "./ac-evo";
import { iracingAdapter } from "./iracing";
import { releaseFeatureFlags, type ReleaseFeatureFlags } from "../platform/runtime/release-feature-flags";

export function gameAdaptersForFeatures(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: import.meta.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER,
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: import.meta.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS,
  }),
) {
  const adapters = [forzaAdapter, f1Adapter, accAdapter, acEvoAdapter];
  if (flags.iracingAdapter) adapters.push(iracingAdapter);
  return adapters;
}

/** Register game adapters. Call once at app startup. */
export function initGameAdapters(
  flags: ReleaseFeatureFlags = releaseFeatureFlags({
    RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
    RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: import.meta.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER,
    RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: import.meta.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS,
  }),
): void {
  for (const adapter of gameAdaptersForFeatures(flags)) registerGame(adapter);
}
