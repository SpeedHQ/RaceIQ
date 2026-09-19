import type { GameId } from "@shared/games/ids";
import type { ReleaseFeatureFlags } from "@shared/platform/runtime/release-feature-flags";

const resolvedClientReleaseFeatures = {
  f1Experiments: false,
  iracingAdapter: false,
  liveSpotterEngineer: false,
  liveSpotterEngineerGameIds: [] as GameId[],
};

export const clientReleaseFeatures: ReleaseFeatureFlags = resolvedClientReleaseFeatures;

function isReleaseFeatureFlags(value: unknown): value is ReleaseFeatureFlags {
  if (!value || typeof value !== "object") return false;
  const flags = value as Record<string, unknown>;
  return (
    typeof flags.f1Experiments === "boolean" &&
    typeof flags.iracingAdapter === "boolean" &&
    typeof flags.liveSpotterEngineer === "boolean" &&
    Array.isArray(flags.liveSpotterEngineerGameIds) &&
    flags.liveSpotterEngineerGameIds.every((gameId) => typeof gameId === "string")
  );
}

export async function loadClientReleaseFeatures(fetcher: typeof fetch = fetch): Promise<ReleaseFeatureFlags> {
  try {
    const response = await fetcher("/api/runtime/features");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isReleaseFeatureFlags(value)) throw new Error("invalid response shape");
    resolvedClientReleaseFeatures.f1Experiments = value.f1Experiments;
    resolvedClientReleaseFeatures.iracingAdapter = value.iracingAdapter;
    resolvedClientReleaseFeatures.liveSpotterEngineer = value.liveSpotterEngineer;
    resolvedClientReleaseFeatures.liveSpotterEngineerGameIds = [...value.liveSpotterEngineerGameIds];
  } catch (error) {
    console.error("Failed to bootstrap runtime feature flags:", error);
  }
  return clientReleaseFeatures;
}
