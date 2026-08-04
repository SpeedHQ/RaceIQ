import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { GameId } from "../../../shared/games/ids";
import type { TuneIssue } from "../../../shared/racing/tuning/issues";
import type { CatalogTune } from "../data/tune-catalog";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

export function useUserTunes(gameId?: GameId) {
  return useQuery({
    queryKey: [...queryKeys.userTunes, gameId ?? null],
    queryFn: async () => rpcJson<any[]>(await client.api.tunes.$get({ query: gameId ? { gameId } : {} })),
  });
}

export function useCatalogTunes() {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.catalogTunes, gameId ?? null],
    queryFn: async () => rpcJson<CatalogTune[]>(await client.api.catalog.tunes.$get({ query: {} }, { headers: gameId ? { "X-Game-Id": gameId } : undefined })),
  });
}

export interface LaptimeEntry {
  track: string;
  carClass: string;
  car: string;
  driver: string;
  laptime: string;
}

export function useLaptimes() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["laptimes", gameId ?? null],
    queryFn: async () => rpcJson<LaptimeEntry[]>(await client.api.laptimes.$get({}, { headers: gameId ? { "X-Game-Id": gameId } : undefined })),
    staleTime: 1000 * 60 * 30,
  });
}

export function useRefreshCommunityTunes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await client.api.tunes.community.refresh.$post();
      if (!res.ok) throw await errorFromResponse(res);
      return res.json() as Promise<{ synced: boolean; count: number; version: string | null }>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.catalogTunes }),
  });
}

export function useCreateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: any) => {
      const res = await client.api.tunes.$post({ json: data });
      if (!res.ok) throw await errorFromResponse(res);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useUpdateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: any) => {
      const res = await client.api.tunes[":id"].$put({ param: { id: String(id) }, json: data } as any);
      if (!res.ok) throw await errorFromResponse(res);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useDeleteTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await client.api.tunes[":id"].$delete({ param: { id: String(id) } });
      if (!res.ok) throw await errorFromResponse(res);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useCloneCatalogTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (catalogId: string) => {
      const res = await client.api.tunes.clone[":catalogId"].$post({ param: { catalogId } });
      if (!res.ok) throw await errorFromResponse(res);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useDuplicateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await client.api.tunes[":id"].duplicate.$post({ param: { id: String(id) } });
      if (!res.ok) throw await errorFromResponse(res);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useLapIssues(lapId: number | null) {
  return useQuery({
    queryKey: ["lap-issues", lapId],
    queryFn: async () => {
      const res = await (client.api.laps as any)[":id"].issues.$get({ param: { id: String(lapId!) } });
      return rpcJson<TuneIssue[]>(res);
    },
    enabled: lapId != null,
    staleTime: 30_000,
  });
}
