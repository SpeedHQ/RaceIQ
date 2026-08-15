import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LapMeta } from "../../../shared/racing/sessions/types";
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


export interface SemanticReplayFrame {
  sequence: number;
  observedAt: { domain: string; milliseconds: number };
  receivedAt: { domain: string; milliseconds: number };
  simulator: string;
  values: Array<{ semanticId: string; value: unknown; state?: string; freshness?: string }>;
}

export interface SemanticLapTelemetry {
  lapId: number;
  requestedSemanticIds: string[];
  sectorTimes?: number[] | null;
  sectorStarts?: number[] | null;
  insights?: unknown[];
  parseError?: string | null;
  envelopes: SemanticReplayFrame[];
}

interface SemanticTelemetryError extends Error {
  parseError?: string;
}

/** Canonical semantic replay; unlike useLapTelemetry this never exposes native packets. */
export function useLapSemanticTelemetry(lapId: number | null) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["lap-semantic-telemetry", lapId, gameId ?? null],
    queryFn: async () => {
      if (!gameId) throw new Error("Missing game context");
      const res = await fetch(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": gameId } });
      const body = (await res.json().catch(() => null)) as (SemanticLapTelemetry & { error?: string; parseError?: string }) | null;
      if (!res.ok || body?.parseError) {
        const error = new Error(body?.parseError ?? body?.error ?? res.statusText) as SemanticTelemetryError;
        error.parseError = body?.parseError;
        throw error;
      }
      if (!body) throw new Error("Unable to replay telemetry");
      return body;
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
