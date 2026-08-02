export interface ReleaseFeatureFlags {
  readonly f1Experiments: boolean;
  readonly iracingAdapter: boolean;
}

export function releaseFeatureFlags(isDevelopment: boolean): ReleaseFeatureFlags {
  return {
    f1Experiments: isDevelopment,
    iracingAdapter: isDevelopment,
  };
}
