import { releaseFeatureFlags } from "@shared/platform/runtime/release-feature-flags";

export const clientReleaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: import.meta.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER,
  RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: import.meta.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS,
});
