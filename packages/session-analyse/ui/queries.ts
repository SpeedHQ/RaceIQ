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
  });
}

export function useSessionLineSpread(sessionId: number | null, lapIds: readonly number[], enabled = true) {
  const { useGameId, fetchSessionLineSpread } = useSessionAnalyseHost();
  const gameId = useGameId();
  const orderedIds = useMemo(() => [...lapIds], [lapIds]);
  return useQuery({
    queryKey: ["session-review-line-spread", gameId ?? null, sessionId, orderedIds],
    queryFn: async () => {
      if (!gameId || sessionId == null || orderedIds.length === 0) return null;
      return fetchSessionLineSpread(gameId, sessionId, orderedIds);
    },
    enabled: enabled && !!gameId && sessionId != null && orderedIds.length > 0,
  });
}
