export interface ReleaseFeatureFlags {
  readonly f1Experiments: boolean;
  readonly iracingAdapter: boolean;
  readonly lmuAdapter: boolean;
}

export interface ReleaseFeatureFlagEnvironment {
  readonly RACEIQ_FEATURE_F1_EXPERIMENTS: string | undefined;
  readonly RACEIQ_FEATURE_IRACING_ADAPTER: string | undefined;
  readonly RACEIQ_FEATURE_LMU_ADAPTER: string | undefined;
}

function booleanFlag(name: keyof ReleaseFeatureFlagEnvironment, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Invalid ${name}: expected "true" or "false"`);
}

export function releaseFeatureFlags(env: ReleaseFeatureFlagEnvironment): ReleaseFeatureFlags {
  return {
    f1Experiments: booleanFlag("RACEIQ_FEATURE_F1_EXPERIMENTS", env.RACEIQ_FEATURE_F1_EXPERIMENTS),
    iracingAdapter: booleanFlag("RACEIQ_FEATURE_IRACING_ADAPTER", env.RACEIQ_FEATURE_IRACING_ADAPTER),
    lmuAdapter: booleanFlag("RACEIQ_FEATURE_LMU_ADAPTER", env.RACEIQ_FEATURE_LMU_ADAPTER),
  };
}
