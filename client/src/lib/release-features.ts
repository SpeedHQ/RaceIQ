import type { ReleaseFeatureFlags } from "@shared/platform/runtime/release-feature-flags";

const resolvedClientReleaseFeatures = {
  f1Experiments: false,
  iracingAdapter: false,
};
export const clientReleaseFeatures: ReleaseFeatureFlags = resolvedClientReleaseFeatures;
function isReleaseFeatureFlags(value: unknown): value is ReleaseFeatureFlags {
  if (!value || typeof value !== "object") return false;
  const flags = value as Record<string, unknown>;
  return typeof flags.f1Experiments === "boolean" && typeof flags.iracingAdapter === "boolean";
}

export async function loadClientReleaseFeatures(fetcher: typeof fetch = fetch): Promise<ReleaseFeatureFlags> {
  try {
    const response = await fetcher("/api/runtime/features");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isReleaseFeatureFlags(value)) throw new Error("invalid response shape");
    resolvedClientReleaseFeatures.f1Experiments = value.f1Experiments;
    resolvedClientReleaseFeatures.iracingAdapter = value.iracingAdapter;
  } catch (error) {
    console.error("Failed to bootstrap runtime feature flags:", error);
  }
  return clientReleaseFeatures;
}
