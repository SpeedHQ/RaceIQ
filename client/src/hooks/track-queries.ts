import { getGame } from "@shared/games/registry";
import type { GameId } from "../../../shared/games/ids";
import type { TrackImagery, TrackImageryGeographicReference } from "../../../shared/racing/tracks/imagery";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
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

export function useTrackSectors(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackSectors(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sectors"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return rpcJson(res);
    },
    enabled: ord != null && !!gameId,
  });
}

export type TrackSectorBoundaryData =
  | {
      ownership: "game";
      editable: false;
      sectorStarts: number[] | null;
      trackLength: number;
    }
  | {
      ownership: "raceiq";
      editable: true;
      sectorStarts: number[];
      trackLength: number;
      s1End: number;
      s2End: number;
    };

function useTrackSectorBoundaryData(ord: number | undefined, gameIdOverride?: GameId | null, enabledOverride = true) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackSectorBoundaries(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sector-boundaries"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return rpcJson<TrackSectorBoundaryData>(res);
    },
    enabled: enabledOverride && ord != null && ord >= 0 && !!gameId,
  });
}

export function useTrackSectorBoundaries(ord: number | undefined, gameIdOverride?: GameId | null, enabledOverride = true) {
  const query = useTrackSectorBoundaryData(ord, gameIdOverride, enabledOverride);
  const data = query.data?.ownership === "raceiq" ? { s1End: query.data.s1End, s2End: query.data.s2End } : null;
  return { ...query, data };
}

export function useTrackOutline(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackOutline(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-outline"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId! } });
      return rpcJson<
        | {
            points?: { x: number; z: number }[];
            labels?: { text: string; x: number; z: number }[];
            pitLines?: { kind: "pit-road" | "merge-line"; points: { x: number; z: number }[] }[];
            flipX?: boolean;
            recorded?: boolean;
            source?: string;
          }
        | { x: number; z: number }[]
      >(res);
    },
    enabled: ord != null && ord >= 0 && !!gameId,
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

export function useTrackCurbs(ord: number | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: ["track-curbs", ord!, gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-curbs"][":ordinal"].$get({ param: { ordinal: String(ord!) }, query: { gameId: gameId ?? undefined } });
      return rpcJson(res);
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

export function useTrackImageryReference(ord: number | undefined, gameIdOverride?: GameId | null, enabledOverride = true) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: ["track-imagery-reference", ord!, gameId ?? null],
    queryFn: async () => {
      const response = await fetch(`/api/dev/track-imagery/reference/${ord}?gameId=${encodeURIComponent(gameId!)}`);
      return rpcJson<TrackImageryGeographicReference | null>(response);
    },
    enabled: enabledOverride && ord != null && ord >= 0 && !!gameId,
    staleTime: Number.POSITIVE_INFINITY,
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
export interface TrackTimingSectorLayout {
  starts: number[] | null;
  ownership: "game" | "raceiq";
  editable: boolean;
  hasRecording: boolean;
}


function validNativeStarts(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value[0] === 0 &&
    value.every((fraction, index) => typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction < 1 && (index === 0 || fraction > value[index - 1]))
  );
}

/**
 * Effective timing-sector layout. Native games are driven exclusively by newest
 * recorded semantic telemetry; they never fall back to editable RaceIQ bounds.
 */
export function useTrackTimingSectorLayout({
  gameId,
  trackOrdinal,
}: {
  gameId: GameId | null;
  trackOrdinal: number;
}) {
  const native = gameId ? getGame(gameId).nativeSectors : false;
  const boundaries = useTrackSectorBoundaryData(trackOrdinal, gameId);

  const data = useMemo<TrackTimingSectorLayout>(() => {
    if (native) {
      const starts = validNativeStarts(boundaries.data?.sectorStarts) ? boundaries.data.sectorStarts : null;
      return { starts, ownership: "game", editable: false, hasRecording: starts !== null };
    }
    const bounds = boundaries.data;
    if (!bounds || bounds.ownership !== "raceiq") return { starts: null, ownership: "raceiq", editable: true, hasRecording: false };
    const { s1End, s2End } = bounds;
    const starts = Number.isFinite(s1End) && Number.isFinite(s2End) && 0 < s1End && s1End < s2End && s2End < 1 ? [0, s1End, s2End] : null;
    return { starts, ownership: "raceiq", editable: true, hasRecording: starts !== null };
  }, [boundaries.data, native]);

  return {
    ...boundaries,
    data,
  };
}
