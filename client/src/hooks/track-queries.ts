import { useQuery } from "@tanstack/react-query";
import type { GameId } from "../../../shared/games/ids";
import type { TrackImagery } from "../../../shared/racing/tracks/imagery";
import type { PitLine } from "../lib/canvas/draw-track";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

export function useTrackName(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackName(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-name"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return res.ok ? res.text() : "";
    },
    enabled: ord != null && gameId != null,
  });
}

export function useTrackSectors(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackSectors(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sectors"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return rpcJson(res);
    },
    enabled: ord != null && !!gameId,
  });
}

export function useTrackSectorBoundaries(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackSectorBoundaries(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sector-boundaries"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return rpcJson<{ s1End: number; s2End: number } | null>(res);
    },
    enabled: ord != null && ord >= 0 && !!gameId,
  });
}

export function useTrackOutline(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackOutline(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-outline"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return rpcJson<
        | { points?: { x: number; z: number }[]; labels?: { text: string; x: number; z: number }[]; pitLines?: PitLine[]; flipX?: boolean; recorded?: boolean; source?: string }
        | { x: number; z: number }[]
      >(res);
    },
    enabled: ord != null && ord >= 0 && !!gameId,
  });
}
export function useTrackImagery(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: ["track-imagery", ord!, gameId ?? null],
    queryFn: async () => {
      const response = await fetch(`/api/track-imagery/${ord}?gameId=${encodeURIComponent(gameId!)}`);
      if (!response.ok) throw new Error(`Unable to load track imagery: ${response.statusText}`);
      return (await response.json()) as TrackImagery | null;
    },
    enabled: ord != null && ord >= 0 && !!gameId,
    staleTime: Number.POSITIVE_INFINITY,
  });
}


export function useTrackBoundaries(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: ["track-boundaries", ord!, gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-boundaries"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId ?? undefined } });
      return rpcJson(res);
    },
    enabled: ord != null && ord >= 0 && !!gameId,
  });
}

export interface TrackCorner {
  index: number;
  label: string;
  distanceStart: number;
  distanceEnd: number;
  minSpeedKph?: number;
  apexDistance?: number;
}

export function useTrackCorners(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: ["track-corners", ord!, gameId ?? null],
    queryFn: async () => {
      const res = await (client.api as any).tracks[":trackOrdinal"].corners.$get({
        param: { trackOrdinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return rpcJson<TrackCorner[]>(res);
    },
    enabled: ord != null && ord > 0 && !!gameId,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
