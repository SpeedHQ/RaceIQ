import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSessionAnalyseHost } from "./host";

export function useReviewLaps(trackId: string | null, carId: string | null, limit = 5) {
  const { useGameId, fetchReviewLaps } = useSessionAnalyseHost();
  const gameId = useGameId();
  return useQuery({
    queryKey: ["review-laps", gameId ?? null, trackId, carId, limit],
    queryFn: async () => {
      if (!gameId || trackId == null || carId == null) return [];
      return fetchReviewLaps(gameId, trackId, carId, limit);
    },
    enabled: !!gameId && trackId != null && carId != null,
    refetchInterval: ({ state }) => state.data?.some(({ processing }) => processing.state === "queued" || processing.state === "processing") ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useSessionLineSpread(sessionId: number | null, lapIds: readonly number[], enabled = true) {
  const { useGameId, fetchSessionLineSpread } = useSessionAnalyseHost();
  const gameId = useGameId();
  const orderedIds = useMemo(() => [...lapIds], [lapIds]);
  const query = useQuery({
    queryKey: ["session-review-line-spread", gameId ?? null, sessionId, orderedIds],
    queryFn: async () => {
      if (!gameId || sessionId == null || orderedIds.length === 0) return null;
      return fetchSessionLineSpread(gameId, sessionId, orderedIds);
    },
    enabled: enabled && !!gameId && sessionId != null && orderedIds.length > 0,
  });
  const error = query.error as (Error & { status?: number; code?: string }) | null;
  const blocked = (error?.status === 409 && error.code === "RECORDING_PROCESSING") ||
    (error?.status === 422 && error.code === "RECORDING_PROCESSING_FAILED");
  return blocked ? { ...query, data: undefined } : query;
}
