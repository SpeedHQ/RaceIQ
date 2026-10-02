import { releaseFeatureFlags } from "../../../shared/platform/runtime/release-feature-flags";

export const serverReleaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: process.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: process.env.RACEIQ_FEATURE_IRACING_ADAPTER,
});
