import type { GameId } from "@raceiq/shared/games/ids";
import type { ReleaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";

const resolvedClientReleaseFeatures = {
  f1Experiments: false,
  iracingAdapter: false,
  ams2Adapter: false,
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
    typeof flags.ams2Adapter === "boolean" &&
    typeof flags.liveSpotterEngineer === "boolean" &&
    Array.isArray(flags.liveSpotterEngineerGameIds) &&
    flags.liveSpotterEngineerGameIds.every((gameId) => typeof gameId === "string")
  );
}

export async function loadClientReleaseFeatures(fetcher: typeof fetch = fetch): Promise<ReleaseFeatureFlags> {
  const response = await fetcher("/api/auth/status");
  if (!response.ok) throw new Error(`Failed to load runtime feature flags (${response.status})`);
  const status: unknown = await response.json();
  const value = status && typeof status === "object" ? (status as Record<string, unknown>).features : undefined;
  if (!isReleaseFeatureFlags(value)) throw new Error("Runtime feature flags response has invalid shape");
  resolvedClientReleaseFeatures.f1Experiments = value.f1Experiments;
  resolvedClientReleaseFeatures.iracingAdapter = value.iracingAdapter;
  resolvedClientReleaseFeatures.ams2Adapter = value.ams2Adapter;
  resolvedClientReleaseFeatures.liveSpotterEngineer = value.liveSpotterEngineer;
  resolvedClientReleaseFeatures.liveSpotterEngineerGameIds = [...value.liveSpotterEngineerGameIds];
  return resolvedClientReleaseFeatures;
}
