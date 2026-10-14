import { releaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";
import { client } from "./rpc";

export let clientReleaseFeatures = releaseFeatureFlags({
  RACEIQ_FEATURE_F1_EXPERIMENTS: import.meta.env.RACEIQ_FEATURE_F1_EXPERIMENTS,
  RACEIQ_FEATURE_IRACING_ADAPTER: import.meta.env.RACEIQ_FEATURE_IRACING_ADAPTER,
});

function isReleaseFeatureFlags(value: unknown): value is typeof clientReleaseFeatures {
  if (typeof value !== "object" || value === null) return false;
  const flags = value as Record<string, unknown>;
  return (
    typeof flags.f1Experiments === "boolean" &&
    typeof flags.iracingAdapter === "boolean"
  );
}

export async function loadClientReleaseFeatures(): Promise<void> {
  const response = await client.api.auth.status.$get();
  if (!response.ok) {
    throw new Error(`Failed to load runtime feature flags (${response.status})`);
  }
  const flags: unknown = (await response.json()).features;
  if (!isReleaseFeatureFlags(flags)) {
    throw new Error("Runtime feature flags response has invalid shape");
  }
  clientReleaseFeatures = flags;
}
