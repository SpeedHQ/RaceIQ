import { useQuery } from "@tanstack/react-query";
import type { GameId } from "../../../../../shared/games/ids";
import { trackConfigurationVenueId } from "../../../../../shared/racing/tracks/configuration";
import { useTrackImageryReference } from "../../../hooks/track-queries";
import { fetchImageryConfiguration, fetchImageryLayout, fetchImageryVenue, imageryWorkbenchQueryKeys } from "./imagery-api";

interface UseImageryPackStatusOptions {
  gameId: GameId;
  trackOrdinal: number;
  configurationRevision: number;
}

function queryError(error: unknown, fallback: string): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : fallback;
}

export function useImageryPackStatus({ gameId, trackOrdinal, configurationRevision }: UseImageryPackStatusOptions) {
  const configurationQuery = useQuery({
    queryKey: imageryWorkbenchQueryKeys.configuration(gameId, trackOrdinal, configurationRevision),
    queryFn: () => fetchImageryConfiguration(gameId, trackOrdinal),
  });
  const configuration = configurationQuery.data ?? null;
  const venueId = configuration ? trackConfigurationVenueId(configuration) : "";

  const layoutQuery = useQuery({
    queryKey: imageryWorkbenchQueryKeys.layout(gameId, trackOrdinal),
    queryFn: () => fetchImageryLayout(gameId, trackOrdinal),
  });
  const catalogReferenceQuery = useTrackImageryReference(trackOrdinal, gameId, !!configuration);
  const venueQuery = useQuery({
    queryKey: imageryWorkbenchQueryKeys.venue(venueId),
    queryFn: () => fetchImageryVenue(venueId),
    enabled: !!configuration && !!venueId,
  });

  const error =
    queryError(configurationQuery.error, "Unable to load track configuration") ??
    queryError(layoutQuery.error, "Unable to load imagery layout") ??
    queryError(catalogReferenceQuery.error, "Unable to load catalog GPS reference") ??
    queryError(venueQuery.error, "Unable to load imagery venue");

  return {
    configuration,
    venueId,
    venue: venueQuery.data ?? null,
    layout: layoutQuery.data ?? null,
    catalogReference: catalogReferenceQuery.data ?? null,
    catalogReferenceLoading: !!configuration && catalogReferenceQuery.isLoading,
    loading: configurationQuery.isLoading || layoutQuery.isLoading || (!!configuration && (catalogReferenceQuery.isLoading || venueQuery.isLoading)),
    error,
  };
}
