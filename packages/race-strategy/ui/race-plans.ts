import { z } from "zod";
import { ActiveRacePlanResponseSchema, RacePlanSchema, RacePlansResponseSchema } from "@raceiq/shared/racing/live/race-plan";
import type { GameId } from "@raceiq/shared/games/ids";
import type { RacePlanInput } from "@raceiq/shared/racing/live/race-plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRaceStrategyHost } from "./host";

export const racePlanKeys = {
  all: (gameId: GameId | null) => ["race-plans", gameId] as const,
  active: ["race-plans", "active"] as const,
};

export function useRacePlans(gameId: GameId | null) {
  const { api } = useRaceStrategyHost();
  return useQuery({
    queryKey: racePlanKeys.all(gameId),
    enabled: gameId != null,
    queryFn: async ({ signal }) => RacePlansResponseSchema.parse(await api.listPlans(gameId!, signal)),
  });
}

export function useActiveRacePlan() {
  const { api } = useRaceStrategyHost();
  return useQuery({
    queryKey: racePlanKeys.active,
    queryFn: async ({ signal }) => ActiveRacePlanResponseSchema.parse(await api.activePlan(signal)),
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
  });
}

export function useSaveRacePlan(gameId: GameId | null) {
  const { api } = useRaceStrategyHost();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: RacePlanInput }) => {
      return RacePlanSchema.parse(await api.savePlan(input, id));
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: racePlanKeys.all(gameId) }),
        queryClient.invalidateQueries({ queryKey: racePlanKeys.active }),
      ]);
    },
  });
}

export function useDeleteRacePlan(gameId: GameId | null) {
  const { api } = useRaceStrategyHost();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => z.object({ deleted: z.literal(true) }).parse(await api.deletePlan(id)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: racePlanKeys.all(gameId) }),
        queryClient.invalidateQueries({ queryKey: racePlanKeys.active }),
      ]);
    },
  });
}

export function useSetActiveRacePlan() {
  const { api } = useRaceStrategyHost();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (planId: string | null) => ActiveRacePlanResponseSchema.parse(await api.setActivePlan(planId)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: racePlanKeys.active });
    },
  });
}
