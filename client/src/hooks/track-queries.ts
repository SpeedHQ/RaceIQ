import { useQuery } from "@tanstack/react-query";
import type { GameId } from "@raceiq/shared/games/ids";
import { resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import type { PitLine } from "../lib/canvas/draw-track";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";
// Route identity types remain explicit until generated client routes catch up.
type TrackIdGet = (input: { param: { trackId: string }; query: { gameId?: string } }) => Promise<Response>;
type TrackIdRoutes = {
  "track-name": { ":trackId": { $get: TrackIdGet } };
  "track-sectors": { ":trackId": { $get: TrackIdGet } };
  "track-sector-boundaries": { ":trackId": { $get: TrackIdGet } };
  "track-outline": { ":trackId": { $get: TrackIdGet } };
  "track-boundaries": { ":trackId": { $get: TrackIdGet } };
  tracks: { ":trackId": { corners: { $get: TrackIdGet } } };
};
const trackIdRoutes = client.api as unknown as TrackIdRoutes;

function isUnresolvedLmuDisplayName(trackId: string | undefined, gameId: GameId | null) {
  return gameId === "lmu" && trackId != null && /\s/.test(trackId.trim()) && resolveLMUTrack(trackId) == null;
}

export function useTrackName(trackId: string | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackName(trackId!), gameId ?? null],
    queryFn: async () => {
      const res = await trackIdRoutes["track-name"][":trackId"].$get({ param: { trackId: encodeURIComponent(trackId!) }, query: { gameId: gameId! } });
      return res.ok ? res.text() : "";
    },
    enabled: trackId != null && trackId.length > 0 && gameId != null,
  });
}

export function useTrackSectors(trackId: string | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackSectors(trackId!), gameId ?? null],
    queryFn: async () => {
      const res = await trackIdRoutes["track-sectors"][":trackId"].$get({ param: { trackId: encodeURIComponent(trackId!) }, query: { gameId: gameId! } });
      return rpcJson(res);
    },
    enabled: trackId != null && !!gameId && !isUnresolvedLmuDisplayName(trackId, gameId),
  });
}

export function useTrackSectorBoundaries(trackId: string | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackSectorBoundaries(trackId!), gameId ?? null],
    queryFn: async () => {
      const res = await trackIdRoutes["track-sector-boundaries"][":trackId"].$get({ param: { trackId: encodeURIComponent(trackId!) }, query: { gameId: gameId! } });
      return rpcJson<{ s1End: number; s2End: number } | null>(res);
    },
    enabled: trackId != null && !!gameId && !isUnresolvedLmuDisplayName(trackId, gameId),
  });
}

export function useTrackOutline(trackId: string | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: [...queryKeys.trackOutline(trackId!), gameId ?? null],
    queryFn: async () => {
      const res = await trackIdRoutes["track-outline"][":trackId"].$get({ param: { trackId: encodeURIComponent(trackId!) }, query: { gameId: gameId! } });
      return rpcJson<{ points?: { x: number; z: number }[]; labels?: { text: string; x: number; z: number }[]; flipX?: boolean; recorded?: boolean; source?: string; pitLines?: PitLine[]; closed?: boolean } | { x: number; z: number }[]>(
        res,
      );
    },
    enabled: trackId != null && !!gameId && !isUnresolvedLmuDisplayName(trackId, gameId),
  });
}

export function useTrackBoundaries(trackId: string | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: ["track-boundaries", trackId!, gameId ?? null],
    queryFn: async () => {
      const res = await trackIdRoutes["track-boundaries"][":trackId"].$get({ param: { trackId: encodeURIComponent(trackId!) }, query: { gameId: gameId ?? undefined } });
      return rpcJson(res);
    },
    enabled: trackId != null && !!gameId && !isUnresolvedLmuDisplayName(trackId, gameId),
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

export function useTrackCorners(trackId: string | undefined, gameIdOverride?: GameId | null) {
  const storeGameId = useGameId();
  const gameId = gameIdOverride ?? storeGameId;
  return useQuery({
    queryKey: ["track-corners", trackId ?? null, gameId ?? null],
    queryFn: async () => {
      const res = await trackIdRoutes.tracks[":trackId"].corners.$get({
        param: { trackId: encodeURIComponent(trackId!) },
        query: { gameId: gameId! },
      });
      return rpcJson<TrackCorner[]>(res);
    },
    enabled: !!trackId && !!gameId && !isUnresolvedLmuDisplayName(trackId, gameId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
