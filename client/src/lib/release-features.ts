import { releaseFeatureFlags } from "@shared/platform/runtime/release-feature-flags";

export let clientReleaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
  RACEIQ_FEATURE_LMU_ADAPTER: import.meta.env.RACEIQ_FEATURE_LMU_ADAPTER,
});

function isReleaseFeatureFlags(value: unknown): value is typeof clientReleaseFeatures {
  if (typeof value !== "object" || value === null) return false;
  const flags = value as Record<string, unknown>;
  return (
    typeof flags.f1Experiments === "boolean" &&
    typeof flags.iracingAdapter === "boolean" &&
    typeof flags.lmuAdapter === "boolean"
  );
}

export async function loadClientReleaseFeatures(): Promise<void> {
  const response = await fetch("/api/runtime/features");
  if (!response.ok) {
    throw new Error(`Failed to load runtime feature flags (${response.status})`);
  }
  const flags: unknown = await response.json();
  if (!isReleaseFeatureFlags(flags)) {
    throw new Error("Runtime feature flags response has invalid shape");
  }
  clientReleaseFeatures = flags;
}
