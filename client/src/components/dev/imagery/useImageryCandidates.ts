import { useCallback, useEffect, useRef, useState } from "react";
import type { GameId } from "../../../../../shared/games/ids";
import type { TrackImageryGeographicBounds, TrackImagerySourceSearchResult } from "../../../../../shared/racing/tracks/imagery";
import { imageryCandidatePreviewUrl, searchImageryCandidates } from "./imagery-api";

interface UseImageryCandidatesOptions {
  bounds: TrackImageryGeographicBounds | null;
  gameId: GameId | null;
  trackOrdinal: number | null;
}

export function useImageryCandidates({ bounds, gameId, trackOrdinal }: UseImageryCandidatesOptions) {
  const [result, setResult] = useState<TrackImagerySourceSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    setResult(null);
    setError(null);
    setLoading(false);
  }, [bounds, gameId, trackOrdinal]);

  const search = useCallback(async () => {
    if (!bounds || !gameId || trackOrdinal == null) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const nextResult = await searchImageryCandidates({ bounds, gameId, trackOrdinal });
      if (requestRef.current === requestId) setResult(nextResult);
    } catch (searchError) {
      if (requestRef.current === requestId) setError(searchError instanceof Error ? searchError.message : "Unable to search open imagery");
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [bounds, gameId, trackOrdinal]);

  const previewUrl = useCallback(
    (candidateId: string) => (bounds && gameId && trackOrdinal != null ? imageryCandidatePreviewUrl(candidateId, bounds, gameId, trackOrdinal) : null),
    [bounds, gameId, trackOrdinal],
  );

  return { result, loading, error, search, previewUrl };
}
