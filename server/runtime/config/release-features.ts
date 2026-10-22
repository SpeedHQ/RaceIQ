import { releaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";

export const serverReleaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER,
  RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS: process.env.RACEIQ_FEATURE_LIVE_SPOTTER_ENGINEER_GAME_IDS,
});
