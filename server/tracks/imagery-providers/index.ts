import { TrackImageryCandidateSchema, type TrackImageryCandidate, type TrackImageryGeographicBounds, type TrackImagerySourceSearchResult } from "../../../shared/racing/tracks/imagery";
import { naipProvider } from "./naip";
import { netherlandsProvider } from "./netherlands";
import { openAerialMapProvider } from "./openaerialmap";
import { sentinel2Provider } from "./sentinel2";
import { walloniaProvider } from "./wallonia";
import { type TrackImageryFetcher, type TrackImageryLocation, type TrackImageryProvider, type TrackImageryProviderResolvedCandidate } from "./types";

export type { TrackImageryFetcher, TrackImageryLocation, TrackImageryProvider, TrackImageryProviderContext, TrackImageryProviderResolvedCandidate } from "./types";

export const TRACK_IMAGERY_PROVIDERS: readonly TrackImageryProvider[] = [naipProvider, walloniaProvider, netherlandsProvider, openAerialMapProvider, sentinel2Provider];

export function trackImageryProvidersForLocation(location: TrackImageryLocation, bounds: TrackImageryGeographicBounds): readonly TrackImageryProvider[] {
  return TRACK_IMAGERY_PROVIDERS.filter((provider) => provider.supports(location, bounds));
}
const coverageRank: Record<TrackImageryCandidate["coverage"], number> = { full: 0, partial: 1, unknown: 2 };
const qualityRank: Record<TrackImageryCandidate["quality"], number> = { hq: 0, context: 1 };
const reliabilityRank: Record<TrackImageryCandidate["geographicReliability"], number> = { authoritative: 0, community: 1, satellite: 2 };
const stabilityRank: Record<TrackImageryCandidate["providerStability"], number> = { authoritative: 0, stable: 1, opportunistic: 2 };

function compareOptionalNumber(left: number | undefined, right: number | undefined, direction: "ascending" | "descending"): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return direction === "ascending" ? left - right : right - left;
}

function capturedTimestamp(value: string): number {
  const timestamp = Date.parse(value.includes("/") ? (value.split("/").at(-1) ?? value) : value);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function compareCapturedAt(left: string | undefined, right: string | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const leftTime = capturedTimestamp(left);
  const rightTime = capturedTimestamp(right);
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return left.localeCompare(right);
  if (!Number.isFinite(leftTime)) return 1;
  if (!Number.isFinite(rightTime)) return -1;
  return rightTime - leftTime;
}

export function rankTrackImageryCandidates(candidates: readonly TrackImageryCandidate[]): TrackImageryCandidate[] {
  return [...candidates].sort((left, right) => {
    const redistribution = Number(left.redistribution !== "allowed") - Number(right.redistribution !== "allowed");
    if (redistribution !== 0) return redistribution;
    const coverage = coverageRank[left.coverage] - coverageRank[right.coverage];
    if (coverage !== 0) return coverage;
    const quality = qualityRank[left.quality] - qualityRank[right.quality];
    if (quality !== 0) return quality;
    const resolution = compareOptionalNumber(left.sourceResolutionM, right.sourceResolutionM, "ascending");
    if (resolution !== 0) return resolution;
    const reliability = reliabilityRank[left.geographicReliability] - reliabilityRank[right.geographicReliability];
    if (reliability !== 0) return reliability;
    const capturedAt = compareCapturedAt(left.capturedAt, right.capturedAt);
    if (capturedAt !== 0) return capturedAt;
    const cloud = compareOptionalNumber(left.cloudCoverPercent, right.cloudCoverPercent, "ascending");
    if (cloud !== 0) return cloud;
    const stability = stabilityRank[left.providerStability] - stabilityRank[right.providerStability];
    if (stability !== 0) return stability;
    return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
  });
}
export async function searchTrackImageryProviders(bounds: TrackImageryGeographicBounds, location: TrackImageryLocation, fetcher: TrackImageryFetcher = fetch): Promise<TrackImagerySourceSearchResult> {
  const providers = trackImageryProvidersForLocation(location, bounds);
  const searches = await Promise.allSettled(providers.map((provider) => provider.search({ bounds, location, fetcher })));
  const candidates: TrackImageryCandidate[] = [];
  const notices: string[] = [];
  const candidateIds = new Set<string>();
  for (let index = 0; index < searches.length; index += 1) {
    const result = searches[index];
    const provider = providers[index];
    if (result.status === "rejected") {
      notices.push(`${provider.name} search unavailable: ${result.reason instanceof Error ? result.reason.message : "unknown error"}`);
      continue;
    }
    let accepted = 0;
    for (const candidateValue of result.value) {
      try {
        const candidate = TrackImageryCandidateSchema.parse(candidateValue);
        if (candidate.provider !== provider.id || !provider.owns(candidate.id)) {
          notices.push(`${provider.name} candidate ${candidate.id} excluded: provider identity mismatch.`);
          continue;
        }
        if (candidate.coverage !== "full" || candidate.redistribution !== "allowed") {
          notices.push(`${provider.name} candidate ${candidate.id} excluded: requires full redistributable coverage.`);
          continue;
        }
        if (candidateIds.has(candidate.id)) {
          notices.push(`${provider.name} candidate ${candidate.id} excluded: duplicate candidate id.`);
          continue;
        }
        candidateIds.add(candidate.id);
        candidates.push(candidate);
        accepted += 1;
      } catch (error) {
        notices.push(`${provider.name} returned invalid candidate: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    if (accepted === 0) notices.push(`${provider.name} has no full coverage for this GPS footprint.`);
  }
  const sourceById = new Map(providers.map((provider) => [provider.id, provider]));
  const sources = new Map<string, TrackImagerySourceSearchResult["sources"][number]>();
  for (const candidate of rankTrackImageryCandidates(candidates)) {
    let source = sources.get(candidate.provider);
    if (!source) {
      const provider = sourceById.get(candidate.provider);
      if (!provider) throw new Error(`Unknown imagery provider ${candidate.provider}`);
      source = { id: provider.id, name: provider.name, candidates: [] };
      sources.set(provider.id, source);
    }
    source.candidates.push(candidate);
  }
  return { sources: [...sources.values()], notices };
}

export type TrackImageryResolvedCandidate = TrackImageryProviderResolvedCandidate & { provider: TrackImageryProvider };

export async function resolveTrackImageryProviderCandidate(
  candidateId: string,
  bounds: TrackImageryGeographicBounds,
  location: TrackImageryLocation,
  fetcher: TrackImageryFetcher = fetch,
): Promise<TrackImageryResolvedCandidate> {
  const provider = TRACK_IMAGERY_PROVIDERS.find((entry) => entry.owns(candidateId));
  if (!provider) throw new Error("Unknown imagery source");
  if (!provider.supports(location, bounds)) throw new Error(`${provider.name} does not support this track location`);
  const resolved = await provider.resolve(candidateId, { bounds, location, fetcher });
  const candidate = TrackImageryCandidateSchema.parse(resolved.candidate);
  if (candidate.id !== candidateId) throw new Error("Imagery provider resolved a different candidate");
  if (candidate.provider !== provider.id) throw new Error("Imagery provider resolved mismatched provenance");
  if (candidate.coverage !== "full") throw new Error("Imagery source does not provide full footprint coverage");
  if (candidate.redistribution !== "allowed") throw new Error("Imagery source is not redistributable");
  return { provider, ...resolved, candidate };
}
