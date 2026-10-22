import { BaselineResponseSchema, PitEstimatePageSchema, StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import type { GameId } from "@raceiq/shared/games/ids";
import type { HistoricalBaseline, StrategyHistoryUpdatedMessage } from "@raceiq/shared/racing/live/strategy";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useRaceStrategyHost } from "./host";
const highestHistoryRevision = new Map<string, number>();
const historyNamespace = (gameId: GameId, driverKey: string) => `${gameId}\u0000${driverKey}`;
const historyRevisionListeners = new Set<() => void>();
const subscribeHistoryRevision = (listener: () => void) => {
  historyRevisionListeners.add(listener);
  return () => { historyRevisionListeners.delete(listener); };
};

export function useStrategyHistoryRevision(gameId: GameId | null, driverKey: string | null) {
  return useSyncExternalStore(subscribeHistoryRevision,
    () => gameId && driverKey ? highestHistoryRevision.get(historyNamespace(gameId, driverKey)) ?? -1 : -1,
    () => -1);
}

export function noteStrategyHistoryRevision(message: StrategyHistoryUpdatedMessage) {
  const key = historyNamespace(message.gameId, message.driverKey);
  if (message.historyRevision > (highestHistoryRevision.get(key) ?? -1)) {
    highestHistoryRevision.set(key, message.historyRevision);
    for (const listener of historyRevisionListeners) listener();
  }
  return message.historyRevision;
}

export function isStrategyHistoryCurrent(gameId: GameId, driverKey: string, historyRevision: number) {
  return historyRevision >= (highestHistoryRevision.get(historyNamespace(gameId, driverKey)) ?? -1);
}

function assertBaselineRevision(gameId: GameId, driverKey: string | null, baseline: HistoricalBaseline) {
  if (!driverKey) return;
  const highest = highestHistoryRevision.get(historyNamespace(gameId, driverKey));
  if (highest != null && baseline.historyRevision < highest) throw new Error("Strategy baseline refresh pending");
}

export const strategyKeys = {
  stints: (gameId: GameId | null, sessionId: number | null) => ["strategy-stints", gameId, sessionId] as const,
  estimates: (gameId: GameId | null, sessionId: number | null, driverKey: string | null, cursor: string | null) => ["strategy-estimates", gameId, sessionId, driverKey, cursor] as const,
  baseline: (gameId: GameId | null, sessionId: number | null, stintId: string | null, driverKey: string | null) => ["strategy-baseline", gameId, sessionId, stintId, driverKey] as const,
};

export function useStrategyStints(gameId: GameId | null, sessionId: number | null) {
  const { api } = useRaceStrategyHost();
  return useQuery({
    queryKey: strategyKeys.stints(gameId, sessionId),
    enabled: !!gameId && sessionId != null,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    queryFn: async () => StintsResponseSchema.parse(await api.stints(gameId!, sessionId!)),
  });
}

export function usePitEstimatePage(gameId: GameId | null, sessionId: number | null, driverKey: string | null, cursor: string | null) {
  const { api } = useRaceStrategyHost();
  return useQuery({
    queryKey: strategyKeys.estimates(gameId, sessionId, driverKey, cursor),
    enabled: !!gameId && sessionId != null,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    queryFn: async () => PitEstimatePageSchema.parse(await api.estimates(gameId!, sessionId!, driverKey, cursor)),
  });
}

export function useStrategyBaseline(gameId: GameId | null, sessionId: number | null, stintId: string | null, driverKey: string | null) {
  const { api } = useRaceStrategyHost();
  return useQuery({
    queryKey: strategyKeys.baseline(gameId, sessionId, stintId, driverKey),
    enabled: !!gameId && sessionId != null && stintId != null,
    refetchOnMount: "always",
    refetchOnReconnect: "always",
    queryFn: async () => {
      const result = BaselineResponseSchema.parse(await api.baseline(gameId!, sessionId!, stintId!));
      assertBaselineRevision(gameId!, driverKey, result.baseline);
      return result;
    },
  });
}

export function useClearPitEstimateHistory(gameId: GameId | null, sessionId: number | null, driverKey: string | null) {
  const { api } = useRaceStrategyHost();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!gameId || sessionId == null || !driverKey) throw new Error("Choose a driver history first");
      return z.object({ cleared: z.number().int().nonnegative() }).parse(await api.clearEstimates(gameId, sessionId, driverKey));
    },
    onSuccess: async () => {
      if (gameId && sessionId != null) await queryClient.invalidateQueries({ queryKey: ["strategy-estimates", gameId, sessionId] });
    },
  });
}
