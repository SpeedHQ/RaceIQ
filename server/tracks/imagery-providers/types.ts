import type { TrackImageryCandidate, TrackImageryGeographicBounds, TrackImagerySourceSearchResult } from "../../../shared/racing/tracks/imagery";

export type TrackImageryFetcher = typeof fetch;

export interface TrackImageryLocation {
  center: {
    latitudeDeg: number;
    longitudeDeg: number;
  };
  country: string;
  region: string;
}

export interface TrackImageryProviderContext {
  bounds: TrackImageryGeographicBounds;
  location: TrackImageryLocation;
  fetcher: TrackImageryFetcher;
}

export interface TrackImageryProviderResolvedCandidate {
  candidate: TrackImageryCandidate;
  providerData?: unknown;
}

export interface TrackImageryProvider {
  id: string;
  name: string;
  maxFetchDimension?: number;
  supports(location: TrackImageryLocation, bounds: TrackImageryGeographicBounds): boolean;
  owns(candidateId: string): boolean;
  search(context: TrackImageryProviderContext): Promise<TrackImageryCandidate[]>;
  resolve(candidateId: string, context: TrackImageryProviderContext): Promise<TrackImageryProviderResolvedCandidate>;
  fetch(resolved: TrackImageryProviderResolvedCandidate, bounds: TrackImageryGeographicBounds, width: number, height: number, fetcher: TrackImageryFetcher): Promise<Uint8Array>;
}

export type TrackImagerySearchResult = TrackImagerySourceSearchResult;
