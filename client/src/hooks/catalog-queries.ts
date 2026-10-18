import { tryGetGame } from "@raceiq/shared/games/registry"
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TrackInfo } from "../components/track/types";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

export function useTracksForGame(gameId: GameId | null) {
  return useQuery({
    queryKey: ["tracks", gameId ?? null],
    queryFn: async () => rpcJson<{ id: string; name: string; variant?: string }[]>(await client.api.tracks.$get({ query: { gameId: gameId! } })),
    enabled: !!gameId,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
export function useCarsForGame(gameId: GameId | null) {
  return useQuery({
    queryKey: ["cars", gameId ?? null],
    queryFn: async () => {
      if (gameId === "acc") {
        const response = await client.api.acc.cars.$get();
        return rpcJson<Array<{ id: number | string; name: string }>>(response).then((rows) => rows.map((row) => ({ id: String(row.id), name: row.name })));
      }
      if (gameId === "ac-evo") {
        const response = await fetch("/api/ac-evo/cars");
        if (!response.ok) throw new Error(`Failed to load car catalog (${response.status})`);
        return (await response.json() as Array<{ id: string; name: string }>).map(({ id, name }) => ({ id, name }));
      }
      const response = await client.api.cars.$get({ header: { "X-Game-Id": gameId! } });
      return rpcJson<{ id: string; name: string }[]>(response);
    },
    enabled: !!gameId,
    staleTime: gameId === "ams2" ? 15_000 : Number.POSITIVE_INFINITY,
    refetchInterval: gameId === "ams2" ? 30_000 : false,
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
      return (await res.json()) as { id: string; name: string; class?: string }[];
    },
    enabled: !!endpoint,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAcEvoCars(enabled = true) {
  return useQuery({
    queryKey: ["ac-evo-cars"],
    queryFn: async () => rpcJson<{ id: string; name: string; class: string }[]>(await client.api["ac-evo"].cars.$get()),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useTracks() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["tracks", gameId ?? null],
    queryFn: async () => rpcJson<TrackInfo[]>(await client.api.tracks.$get({ query: { gameId: gameId! } })),
    enabled: !!gameId,
    refetchInterval: gameId === "ams2" ? 30_000 : false,
  });
}
export function useResolveNames(trackIds: string[], carIds: string[]) {
  const gameId = useGameId();
  const trackKey = JSON.stringify(trackIds.slice().sort());
  const carKey = JSON.stringify(carIds.slice().sort());
  return useQuery({
    queryKey: ["resolve-names", gameId ?? null, trackKey, carKey],
    queryFn: async () => {
      const res = await client.api["resolve-names"].$get({
        query: {
          gameId: gameId!,
          tracks: trackIds.length > 0 ? JSON.stringify(trackIds) : undefined,
          cars: carIds.length > 0 ? JSON.stringify(carIds) : undefined,
        },
      });
      return rpcJson<{ trackNames: Record<string, string>; carNames: Record<string, string> }>(res);
    },
    enabled: !!gameId && (trackIds.length > 0 || carIds.length > 0),
  });
}

export function useCarName(carId: string | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.carName(carId!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["car-name"][":carId"].$get({ param: { carId: encodeURIComponent(carId!) }, query: { gameId: gameId! } });
      return res.ok ? res.text() : "";
    },
    enabled: !!carId && !!gameId,
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

function useAccCarClass(carId: string | undefined) {
  return useQuery({
    queryKey: ["acc-car-class", carId],
    queryFn: async () => {
      const res = await client.api.acc.cars[":carId"].class.$get({ param: { carId: encodeURIComponent(carId!) } });
      if (!res.ok) return null;
      const body = (await res.json()) as { class: string | null };
      return body.class;
    },
    enabled: !!carId,
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

export function useTirePressureOptimal(gameId: GameId, carId: string | undefined, enabled = true): { min: number; max: number } | undefined {
  const { data: accClass } = useAccCarClass(enabled && gameId === "acc" ? carId : undefined);
  if (!enabled) return tryGetGame(gameId)?.tirePressureOptimal;
  if (gameId === "acc") return accClass ? ACC_PRESSURE_BY_CLASS[accClass] : undefined;
  return tryGetGame(gameId)?.tirePressureOptimal;
}
