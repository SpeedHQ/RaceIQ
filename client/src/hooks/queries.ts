/* eslint-disable @typescript-eslint/no-explicit-any */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { LapMeta, SessionMeta, TelemetryPacket } from "@shared/types";
import type { CatalogTune } from "../data/tune-catalog";
import { client } from "../lib/rpc";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";
import { useGameId } from "../stores/game";
// ── Query Keys ──────────────────────────────────────────────────────────────
export const queryKeys = {
  laps: ["laps"] as const,
  lap: (id: number) => ["laps", id] as const,
  status: ["status"] as const,
  settings: ["settings"] as const,
  trackName: (ord: number) => ["track-name", ord] as const,
  trackSectors: (ord: number) => ["track-sectors", ord] as const,
  trackSectorBoundaries: (ord: number) => ["track-sector-boundaries", ord] as const,
  trackOutline: (ord: number) => ["track-outline", ord] as const,
  trackCurbs: (ord: number) => ["track-curbs", ord] as const,
  sessions: ["sessions"] as const,
  tracks: ["tracks"] as const,
  carName: (ord: number) => ["car-name", ord] as const,
  gripHistory: ["grip-history"] as const,
  fuelHistory: ["fuel-history"] as const,
  telemetryHistory: ["telemetry-history"] as const,
  userTunes: ["user-tunes"] as const,
  catalogTunes: ["catalog-tunes"] as const,
  tuneAssignments: ["tune-assignments"] as const,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
async function rpcJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Settings ────────────────────────────────────────────────────────────────
export function useSettings() {
  const { data: displaySettings = DEFAULT_DISPLAY_SETTINGS, isSuccess } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: async () => {
      const res = await client.api.settings.$get();
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    },
  });
  return { displaySettings, settingsLoaded: isSuccess };
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (settings: any) => {
      const res = await client.api.settings.$put({ json: settings });
      if (!res.ok) throw new Error(res.statusText);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings }),
  });
}

// ── Laps ────────────────────────────────────────────────────────────────────
export function useLaps(options?: { refetchInterval?: number | false }) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["laps", gameId ?? null],
    queryFn: async () => {
      const res = await client.api.laps.$get({
        query: { gameId: gameId ?? undefined },
      });
      return rpcJson<LapMeta[]>(res);
    },
    ...options,
  });
}

export function useLap(id: number | null) {
  return useQuery({
    queryKey: queryKeys.lap(id!),
    queryFn: async () => {
      const res = await client.api.laps[":id"].$get({ param: { id: String(id!) } });
      return rpcJson(res);
    },
    enabled: id != null,
  });
}

export function useLapTelemetry(lapId: number | null) {
  return useQuery({
    queryKey: ["lap-telemetry", lapId],
    queryFn: async () => {
      const res = await client.api.laps[":id"].$get({ param: { id: String(lapId!) } });
      if (!res.ok) throw new Error(res.statusText);
      return res.json() as Promise<{
        telemetry: TelemetryPacket[];
        sectorTimes: { times: [number, number, number]; s1Idx: number; s2Idx: number; firstDist: number; lapDist: number } | null;
        [key: string]: any;
      }>;
    },
    enabled: lapId != null,
  });
}

export function useDeleteLap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await client.api.laps[":id"].$delete({ param: { id: String(id) } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.laps });
      qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

export function useBulkDeleteLaps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: number[]) => {
      await client.api.laps["bulk-delete"].$post({ json: { ids } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.laps });
      qc.invalidateQueries({ queryKey: queryKeys.sessions });
      qc.invalidateQueries({ queryKey: queryKeys.tracks });
    },
  });
}

// ── Status ──────────────────────────────────────────────────────────────────
// Server status is now pushed via WebSocket → useTelemetryStore().serverStatus
// The REST endpoint /api/status still exists for one-off checks.

// ── Track info ──────────────────────────────────────────────────────────────
export function useTrackName(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackName(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-name"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return res.ok ? res.text() : "";
    },
    enabled: ord != null && ord > 0 && gameId != null,
  });
}

export function useTrackSectors(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackSectors(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sectors"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return rpcJson(res);
    },
    enabled: ord != null && ord > 0 && !!gameId,
  });
}

export function useTrackSectorBoundaries(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackSectorBoundaries(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-sector-boundaries"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return rpcJson(res);
    },
    enabled: ord != null && ord > 0 && !!gameId,
  });
}

export function useTrackOutline(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.trackOutline(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-outline"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return rpcJson(res);
    },
    enabled: ord != null && ord > 0 && !!gameId,
  });
}

export function useTrackBoundaries(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["track-boundaries", ord!, gameId ?? null],
    queryFn: async () => {
      const res = await client.api["track-boundaries"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId ?? undefined },
      });
      return rpcJson(res);
    },
    enabled: ord != null && ord > 0 && !!gameId,
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

export function useSessions() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["sessions", gameId ?? null],
    queryFn: async () => {
      const res = await client.api.sessions.$get({
        query: { gameId: gameId ?? undefined },
      });
      return rpcJson<SessionMeta[]>(res);
    },
  });
}

export function useTracks() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["tracks", gameId ?? null],
    queryFn: async () => {
      const res = await client.api.tracks.$get({
        query: { gameId: gameId ?? undefined },
      });
      return rpcJson(res);
    },
  });
}

// ── Car info ────────────────────────────────────────────────────────────────
export function useCarName(ord: number | undefined) {
  const gameId = useGameId();
  return useQuery({
    queryKey: [...queryKeys.carName(ord!), gameId ?? null],
    queryFn: async () => {
      const res = await client.api["car-name"][":ordinal"].$get({
        param: { ordinal: String(ord!) },
        query: { gameId: gameId! },
      });
      return res.ok ? res.text() : "";
    },
    enabled: ord != null && ord > 0 && gameId != null,
  });
}

// ── Live telemetry history ──────────────────────────────────────────────────
export function useGripHistory() {
  return useQuery({
    queryKey: queryKeys.gripHistory,
    queryFn: async () => rpcJson(await client.api["grip-history"].$get()),
    refetchInterval: 1_000,
  });
}

export function useFuelHistory() {
  return useQuery({
    queryKey: queryKeys.fuelHistory,
    queryFn: async () => rpcJson(await client.api["fuel-history"].$get()),
    refetchInterval: 1_000,
  });
}

export function useTelemetryHistory() {
  return useQuery({
    queryKey: queryKeys.telemetryHistory,
    queryFn: async () => rpcJson(await client.api["telemetry-history"].$get()),
    refetchInterval: 1_000,
  });
}

// ── Export ───────────────────────────────────────────────────────────────────
export function useExportLap() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await client.api.laps[":id"].export.$get({ param: { id: String(id) } });
      return res.blob();
    },
  });
}

// ── Tunes ────────────────────────────────────────────────────────────────────
export function useUserTunes() {
  return useQuery({
    queryKey: queryKeys.userTunes,
    queryFn: async () => rpcJson<any[]>(await client.api.tunes.$get({ query: {} })),
  });
}

export function useCatalogTunes() {
  return useQuery({
    queryKey: queryKeys.catalogTunes,
    queryFn: async () => rpcJson<CatalogTune[]>(await client.api.catalog.tunes.$get({ query: {} })),
  });
}

export function useCreateTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: any) => {
      const res = await client.api.tunes.$post({ json: data });
      if (!res.ok) throw new Error((await res.json() as any).error ?? res.statusText);
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
      if (!res.ok) throw new Error((await res.json() as any).error ?? res.statusText);
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
      if (!res.ok) throw new Error((await res.json() as any).error ?? res.statusText);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

export function useCloneCatalogTune() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (catalogId: string) => {
      const res = await client.api.tunes.clone[":catalogId"].$post({ param: { catalogId } });
      if (!res.ok) throw new Error((await res.json() as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userTunes }),
  });
}

// ── Tune Assignments ─────────────────────────────────────────────────────────
export function useTuneAssignments() {
  return useQuery({
    queryKey: queryKeys.tuneAssignments,
    queryFn: async () => rpcJson<any[]>(await client.api["tune-assignments"].$get({ query: {} })),
  });
}

export function useSetTuneAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { carOrdinal: number; trackOrdinal: number; tuneId: number }) => {
      const res = await client.api["tune-assignments"].$put({ json: data });
      if (!res.ok) throw new Error((await res.json() as any).error ?? res.statusText);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tuneAssignments }),
  });
}

export function useDeleteTuneAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ carOrdinal, trackOrdinal }: { carOrdinal: number; trackOrdinal: number }) => {
      await client.api["tune-assignments"][":carOrdinal"][":trackOrdinal"].$delete({
        param: { carOrdinal: String(carOrdinal), trackOrdinal: String(trackOrdinal) },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.tuneAssignments }),
  });
}
