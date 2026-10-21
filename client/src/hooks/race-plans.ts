import { z } from "zod";
import { ActiveRacePlanResponseSchema, RacePlanSchema, RacePlansResponseSchema } from "@raceiq/shared/racing/live/race-plan";
import type { GameId } from "@raceiq/shared/games/ids";
import type { RacePlanInput } from "@raceiq/shared/racing/live/race-plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";

export const racePlanKeys = {
  all: (gameId: GameId | null) => ["race-plans", gameId] as const,
  active: ["race-plans", "active"] as const,
};

export function useRacePlans(gameId: GameId | null) {
  return useQuery({
    queryKey: racePlanKeys.all(gameId),
    enabled: gameId != null,
    queryFn: async ({ signal }) => RacePlansResponseSchema.parse(await rpcJson<unknown>(await client.api["race-plans"].$get({ query: { gameId: gameId! } }, { init: { signal } }))),
  });
}

export function useActiveRacePlan() {
  return useQuery({
    queryKey: racePlanKeys.active,
    queryFn: async ({ signal }) => ActiveRacePlanResponseSchema.parse(await rpcJson<unknown>(await client.api["race-plans"].active.$get({}, { init: { signal } }))),
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: 15_000,
  });
}

export function useSaveRacePlan(gameId: GameId | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: RacePlanInput }) => {
      if (id) return RacePlanSchema.parse(await rpcJson<unknown>(await client.api["race-plans"][":id"].$put({ param: { id }, json: input })));
      return RacePlanSchema.parse(await rpcJson<unknown>(await client.api["race-plans"].$post({ json: input })));
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => z.object({ deleted: z.literal(true) }).parse(await rpcJson<unknown>(await client.api["race-plans"][":id"].$delete({ param: { id } }))),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: racePlanKeys.all(gameId) }),
        queryClient.invalidateQueries({ queryKey: racePlanKeys.active }),
      ]);
    },
  });
}

export function useSetActiveRacePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (planId: string | null) => ActiveRacePlanResponseSchema.parse(await rpcJson<unknown>(await client.api["race-plans"].active.$put({ json: { planId } }))),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: racePlanKeys.active });
    },
  });
}
