import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import type { SectorTimeline } from "../lib/lap-sectors";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

export function useLaps(options?: { refetchInterval?: number | false }) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["laps", gameId ?? null],
    queryFn: async () => {
      const res = await client.api.laps.$get({ query: { gameId: gameId ?? undefined } });
      return rpcJson<LapMeta[]>(res);
    },
    ...options,
  });
}

export function useLapTelemetry(lapId: number | null) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["lap-telemetry", lapId, gameId ?? null],
    queryFn: async () => {
      if (!gameId) throw new Error("Missing game context");
      const res = await client.api.laps[":id"].$get({ param: { id: String(lapId!) } }, { headers: { "X-Game-Id": gameId } });
      if (!res.ok) throw new Error(res.statusText);
      return res.json() as Promise<{
        telemetry: TelemetryPacket[];
        sectorTimes: SectorTimeline | null;
        [key: string]: any;
      }>;
    },
    enabled: lapId != null && gameId != null,
    gcTime: 0,
    staleTime: 0,
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

/** Include/exclude a lap from tuning aggregate. */
export function useSetLapExcluded() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ lapId, excluded }: { lapId: number; excluded: boolean; experimentId?: number | null }) => {
      const res = await (client.api.laps as any)[":id"]["experiment-excluded"].$post({
        param: { id: String(lapId) },
        json: { excluded },
      });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json()) as { ok: true; lapId: number; excluded: boolean };
    },
    onSuccess: (_data, { experimentId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.laps });
      if (experimentId != null) {
        qc.invalidateQueries({ queryKey: ["experiment", experimentId] });
        qc.invalidateQueries({ queryKey: ["experiment-tests", experimentId] });
        qc.invalidateQueries({ queryKey: ["experiment-chat-history", experimentId] });
      }
    },
  });
}
