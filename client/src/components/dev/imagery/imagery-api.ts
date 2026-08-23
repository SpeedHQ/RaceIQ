import type { QueryClient } from "@tanstack/react-query";
import type { GameId } from "../../../../../shared/games/ids";
import type { TrackConfiguration } from "../../../../../shared/racing/tracks/configuration";
import {
  TrackImageryOutputBudgetResultSchema,
  type TrackImageryCalibration,
  type TrackImageryGeographicBounds,
  type TrackImageryLayoutManifest,
  type TrackImageryOutputBudgetResult,
  type TrackImagerySourceSearchResult,
  type TrackImageryVenueManifest,
} from "../../../../../shared/racing/tracks/imagery";
import { devClient } from "../../../lib/rpc";

interface ApiError {
  error?: string;
}

export interface ImageryCandidateSearchRequest {
  bounds: TrackImageryGeographicBounds;
  gameId: GameId;
  trackOrdinal: number;
}

export interface ImageryCandidateEstimateRequest extends ImageryCandidateSearchRequest {
  candidateId: string;
  venueId: string;
}

export interface ImageryCandidateImportRequest extends ImageryCandidateSearchRequest {
  candidateId: string;
  calibration: TrackImageryCalibration;
}

export type ImageryLayerManifest = TrackImageryVenueManifest["layers"][number];

export const imageryWorkbenchQueryKeys = {
  configuration: (gameId: GameId, trackOrdinal: number, configurationRevision: number) => ["imagery-workbench", "configuration", gameId, trackOrdinal, configurationRevision] as const,
  layout: (gameId: GameId, trackOrdinal: number) => ["imagery-workbench", "layout", gameId, trackOrdinal] as const,
  venue: (venueId: string) => ["imagery-workbench", "venue", venueId] as const,
};

async function jsonResult<T>(response: Response, fallbackError: string): Promise<T> {
  const result = (await response.json()) as T | ApiError;
  if (!response.ok) throw new Error((result as ApiError).error ?? fallbackError);
  return result as T;
}

function jsonRequestInit(value: unknown): RequestInit {
  return {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  };
}

export async function fetchImageryConfiguration(gameId: GameId, trackOrdinal: number): Promise<TrackConfiguration | null> {
  const response = await devClient.api.dev["track-configurations"][":ordinal"].$get({
    param: { ordinal: String(trackOrdinal) },
    query: { gameId },
  });
  return jsonResult<TrackConfiguration | null>(response, "Unable to load track configuration");
}

export async function fetchImageryLayout(gameId: GameId, trackOrdinal: number): Promise<TrackImageryLayoutManifest | null> {
  const response = await devClient.api.dev["track-imagery"].layouts[":ordinal"].$get({
    param: { ordinal: String(trackOrdinal) },
    query: { gameId },
  });
  return jsonResult<TrackImageryLayoutManifest | null>(response, "Unable to load layout imagery");
}

export async function fetchImageryVenue(venueId: string): Promise<TrackImageryVenueManifest | null> {
  const response = await devClient.api.dev["track-imagery"].venues.manifest.$get({ query: { venueId } });
  return jsonResult<TrackImageryVenueManifest | null>(response, "Unable to load imagery venue");
}

export async function searchImageryCandidates(request: ImageryCandidateSearchRequest): Promise<TrackImagerySourceSearchResult> {
  const response = await devClient.api.dev["track-imagery"].sources.search.$post({ json: request });
  return jsonResult<TrackImagerySourceSearchResult>(response, "Unable to search open imagery");
}

export async function estimateImageryCandidate(request: ImageryCandidateEstimateRequest): Promise<TrackImageryOutputBudgetResult> {
  const response = await devClient.api.dev["track-imagery"].sources.estimate.$post({ json: request });
  const result = await jsonResult<unknown>(response, "Unable to estimate open imagery output");
  return TrackImageryOutputBudgetResultSchema.parse(result);
}

export async function importImageryCandidate(venueId: string, request: ImageryCandidateImportRequest): Promise<TrackImageryVenueManifest> {
  const response = await devClient.api.dev["track-imagery"].venues.base.source.$post({ query: { venueId } }, { init: jsonRequestInit(request) });
  return jsonResult<TrackImageryVenueManifest>(response, "Unable to save venue base");
}

export async function uploadManualImageryBase(file: File, manifest: TrackImageryVenueManifest): Promise<TrackImageryVenueManifest> {
  const body = new FormData();
  body.set("file", file);
  body.set("manifest", JSON.stringify(manifest));
  const response = await devClient.api.dev["track-imagery"].venues.base.$post({ query: { venueId: manifest.venueId } }, { init: { body } });
  return jsonResult<TrackImageryVenueManifest>(response, "Unable to save venue base");
}

export async function updateImageryManifest(manifest: TrackImageryVenueManifest): Promise<TrackImageryVenueManifest> {
  const response = await devClient.api.dev["track-imagery"].venues.manifest.$put({ query: { venueId: manifest.venueId } }, { init: jsonRequestInit(manifest) });
  return jsonResult<TrackImageryVenueManifest>(response, "Unable to save venue base");
}

export async function uploadImageryLayer(venueId: string, file: File, layer: ImageryLayerManifest): Promise<TrackImageryVenueManifest> {
  const body = new FormData();
  body.set("file", file);
  body.set("layer", JSON.stringify(layer));
  const response = await devClient.api.dev["track-imagery"].venues.layers[":layerId"].$post({ param: { layerId: layer.id }, query: { venueId } }, { init: { body } });
  return jsonResult<TrackImageryVenueManifest>(response, "Unable to save overlay layer");
}

export async function saveImageryLayout(gameId: GameId, trackOrdinal: number, layout: TrackImageryLayoutManifest): Promise<TrackImageryLayoutManifest> {
  const response = await devClient.api.dev["track-imagery"].layouts[":ordinal"].$put(
    {
      param: { ordinal: String(trackOrdinal) },
      query: { gameId },
    },
    { init: jsonRequestInit(layout) },
  );
  return jsonResult<TrackImageryLayoutManifest>(response, "Unable to save layout imagery");
}

export function imageryCandidatePreviewUrl(candidateId: string, bounds: TrackImageryGeographicBounds, gameId: GameId, trackOrdinal: number): string {
  const query = new URLSearchParams({
    candidateId,
    gameId,
    trackOrdinal: String(trackOrdinal),
    west: String(bounds.west),
    south: String(bounds.south),
    east: String(bounds.east),
    north: String(bounds.north),
  });
  return `/api/dev/track-imagery/sources/preview?${query}`;
}

export async function invalidateImageryRuntimeQueries(queryClient: Pick<QueryClient, "invalidateQueries">, gameId: GameId, trackOrdinal: number): Promise<void> {
  await Promise.all([queryClient.invalidateQueries({ queryKey: ["track-imagery", trackOrdinal, gameId] }), queryClient.invalidateQueries({ queryKey: ["track-imagery-configurations"] })]);
}
