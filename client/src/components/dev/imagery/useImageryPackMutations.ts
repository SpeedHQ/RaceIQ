import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { GameId } from "../../../../../shared/games/ids";
import { TRACK_IMAGERY_MANIFEST_VERSION, type TrackImageryLayoutManifest, type TrackImageryVenueManifest } from "../../../../../shared/racing/tracks/imagery";
import {
  imageryWorkbenchQueryKeys,
  invalidateImageryRuntimeQueries,
  saveImageryLayout,
  updateImageryManifest,
  uploadImageryLayer,
  uploadManualImageryBase,
  type ImageryLayerManifest,
} from "./imagery-api";

interface UseImageryPackMutationsOptions {
  gameId: GameId;
  trackOrdinal: number;
  venueId: string;
}

export function useImageryPackMutations({ gameId, trackOrdinal, venueId }: UseImageryPackMutationsOptions) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetVersion, setAssetVersion] = useState(0);

  const run = useCallback(async <T>(operation: () => Promise<T>, fallbackError: string): Promise<T> => {
    setPending(true);
    setError(null);
    try {
      return await operation();
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : fallbackError);
      throw operationError;
    } finally {
      setPending(false);
    }
  }, []);

  const saveManualBase = useCallback(
    (file: File, manifest: TrackImageryVenueManifest) =>
      run(async () => {
        const savedVenue = await uploadManualImageryBase(file, manifest);
        queryClient.setQueryData(imageryWorkbenchQueryKeys.venue(venueId), savedVenue);
        return savedVenue;
      }, "Unable to save venue base"),
    [queryClient, run, venueId],
  );

  const saveManifest = useCallback(
    (manifest: TrackImageryVenueManifest) =>
      run(async () => {
        const savedVenue = await updateImageryManifest(manifest);
        queryClient.setQueryData(imageryWorkbenchQueryKeys.venue(venueId), savedVenue);
        return savedVenue;
      }, "Unable to save venue base"),
    [queryClient, run, venueId],
  );

  const saveLayer = useCallback(
    (file: File, layer: ImageryLayerManifest) =>
      run(async () => {
        const savedVenue = await uploadImageryLayer(venueId, file, layer);
        queryClient.setQueryData(imageryWorkbenchQueryKeys.venue(venueId), savedVenue);
        return savedVenue;
      }, "Unable to save overlay layer"),
    [queryClient, run, venueId],
  );

  const saveLayout = useCallback(
    (layers: string[]) =>
      run(async () => {
        const payload: TrackImageryLayoutManifest = {
          version: TRACK_IMAGERY_MANIFEST_VERSION,
          gameId,
          trackOrdinal,
          layers,
        };
        const savedLayout = await saveImageryLayout(gameId, trackOrdinal, payload);
        queryClient.setQueryData(imageryWorkbenchQueryKeys.layout(gameId, trackOrdinal), savedLayout);
        return savedLayout;
      }, "Unable to save layout imagery"),
    [gameId, queryClient, run, trackOrdinal],
  );

  const markAssetChanged = useCallback(() => setAssetVersion((version) => version + 1), []);
  const invalidateRuntime = useCallback(() => invalidateImageryRuntimeQueries(queryClient, gameId, trackOrdinal), [gameId, queryClient, trackOrdinal]);

  return {
    pending,
    error,
    assetVersion,
    saveManualBase,
    saveManifest,
    saveLayer,
    saveLayout,
    markAssetChanged,
    invalidateRuntime,
  };
}
