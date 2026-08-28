import { tryGetGame } from "@shared/games/registry";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { GameId } from "../../../shared/games/ids";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

export function useTracksForGame(gameId: GameId | null) {
  return useQuery({
    queryKey: ["tracks", gameId ?? null],
    queryFn: async () => rpcJson<{ ordinal: number; name: string; variant?: string }[]>(await client.api.tracks.$get({ query: { gameId: gameId! } })),
    enabled: !!gameId,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export interface MotecTargetInfo {
  gameId: GameId;
  displayName: string;
  routePrefix: string;
  carsEndpoint: string;
  limitations: string[];
}

export function useMotecTargets() {
  return useQuery({
    queryKey: ["motec-targets"],
    queryFn: async () => rpcJson<MotecTargetInfo[]>(await client.api.motec.targets.$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useCarsFromEndpoint(endpoint: string | null) {
  return useQuery({
    queryKey: ["motec-cars", endpoint],
    queryFn: async () => {
      const res = await fetch(endpoint!);
      if (!res.ok) throw new Error(`Failed to load cars (${res.status})`);
      return (await res.json()) as { ordinal: number; name: string; class?: string }[];
    },
    enabled: !!endpoint,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAcEvoCars(enabled = true) {
  return useQuery({
    queryKey: ["ac-evo-cars"],
    queryFn: async () => rpcJson<{ ordinal: number; name: string; class: string }[]>(await client.api["ac-evo"].cars.$get()),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useTracks() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["tracks", gameId ?? null],
    queryFn: async () => rpcJson(await client.api.tracks.$get({ query: { gameId: gameId! } })),
    enabled: !!gameId,
  });
}
export function useResolveNames(trackOrdinals: number[], carOrdinals: number[]) {
  const gameId = useGameId();
  const trackKey = trackOrdinals.slice().sort().join(",");
  const carKey = carOrdinals.slice().sort().join(",");
  return useQuery({
    queryKey: ["resolve-names", gameId ?? null, trackKey, carKey],
    queryFn: async () => {
      const res = await client.api["resolve-names"].$get({
        query: {
          gameId: gameId!,
          tracks: trackOrdinals.length > 0 ? trackOrdinals.join(",") : undefined,
          cars: carOrdinals.length > 0 ? carOrdinals.join(",") : undefined,
        },
      });
      return rpcJson<{ trackNames: Record<string, string>; carNames: Record<string, string> }>(res);
    },
    enabled: !!gameId && (trackOrdinals.length > 0 || carOrdinals.length > 0),
  });
}

export function useCarName(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.carName(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["car-name"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return res.ok ? res.text() : "";
    },
    enabled: ord != null && ord > 0 && gameId != null,
  });
}

export function useAccCarName() {
  const { data: cars = [] } = useQuery({
    queryKey: ["acc-cars"],
    queryFn: () => client.api.acc.cars.$get().then((r) => r.json() as unknown as { model: string; name: string }[]),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return useMemo(() => {
    const byModel = new Map(cars.map((c) => [c.model, c.name] as const));
    return (model: string | null | undefined) => (model ? (byModel.get(model) ?? model) : model);
  }, [cars]);
}

function useAccCarClass(ordinal: number | undefined) {
  return useQuery({
    queryKey: ["acc-car-class", ordinal],
    queryFn: async () => {
      const res = await client.api.acc.cars[":ordinal"].class.$get({ param: { ordinal: String(ordinal!) } });
      if (!res.ok) return null;
      const body = (await res.json()) as { class: string | null };
      return body.class;
    },
    enabled: ordinal != null && ordinal >= 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const ACC_PRESSURE_BY_CLASS: Record<string, { min: number; max: number }> = {
  GT3: { min: 26.0, max: 27.2 },
  GT2: { min: 26.0, max: 27.2 },
  GTC: { min: 26.0, max: 27.2 },
  CHL: { min: 26.0, max: 27.2 },
  GT4: { min: 26.5, max: 27.5 },
  TCX: { min: 30.0, max: 32.0 },
};

export function useTirePressureOptimal(gameId: GameId, ordinal: number | undefined): { min: number; max: number } | undefined {
  const { data: accClass } = useAccCarClass(gameId === "acc" ? ordinal : undefined);
  if (gameId === "acc") return accClass ? ACC_PRESSURE_BY_CLASS[accClass] : undefined;
  return tryGetGame(gameId)?.tirePressureOptimal;
}
