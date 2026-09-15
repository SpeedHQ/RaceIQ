import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LineSpreadTrace } from "./experiments";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { ComparisonData, AlignedTrace } from "../../../shared/racing/comparison/types";
import type { AlignedLapSet } from "@shared/racing/laps/alignment/types";
import { useAlignedTelemetry } from "./aligned-telemetry";
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

export function useReviewLaps(trackOrdinal: number | null, carOrdinal: number | null, limit = 5) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["review-laps", gameId ?? null, trackOrdinal, carOrdinal, limit],
    queryFn: async () => {
      if (!gameId || trackOrdinal == null || carOrdinal == null) return [];
      const res = await client.api.laps.review.$get({
        query: { gameId, trackOrdinal: String(trackOrdinal), carOrdinal: String(carOrdinal), limit: String(limit) },
      });
      return rpcJson<LapMeta[]>(res);
    },
    enabled: !!gameId && trackOrdinal != null && carOrdinal != null,
  });
}

export function useSessionLaps(sessionId: number | null) {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["session-laps", gameId ?? null, sessionId],
    queryFn: async () => {
      if (!gameId || sessionId == null) return [];
      const res = await client.api.laps.$get({ query: { gameId, sessionId: String(sessionId) } });
      return rpcJson<LapMeta[]>(res);
    },
    enabled: !!gameId && sessionId != null,
  });
}

export function useSessionLineSpread(sessionId: number | null, lapIds: readonly number[], enabled = true) {
  const gameId = useGameId();
  const orderedIds = useMemo(() => [...lapIds], [lapIds]);
  return useQuery({
    queryKey: ["session-review-line-spread", gameId ?? null, sessionId, orderedIds],
    queryFn: async () => {
      if (!gameId || sessionId == null || orderedIds.length === 0) return null;
      const res = await client.api.laps["review-line-spread"].$get({ query: { gameId, sessionId: String(sessionId), lapIds: orderedIds.join(",") } });
      return rpcJson<LineSpreadTrace>(res);
    },
    enabled: enabled && !!gameId && sessionId != null && orderedIds.length > 0,
  });
}
function alignedComparison(set: AlignedLapSet, lapA: LapMeta, lapB: LapMeta): ComparisonData {
  const a = set.laps[0]!,
    b = set.laps[1]!;
  const traces: AlignedTrace = {
    distance: [...set.distanceMeters],
    sourceIndicesA: [...a.sourceIndices],
    sourceIndicesB: [...b.sourceIndices],
    speedA: [...a.speedMps].map((v) => v * 2.236936),
    speedB: [...b.speedMps].map((v) => v * 2.236936),
    throttleA: [...a.throttle],
    throttleB: [...b.throttle],
    brakeA: [...a.brake],
    brakeB: [...b.brake],
    steerA: [...a.steer],
    steerB: [...b.steer],
    gearA: [...a.gear],
    gearB: [...b.gear],
    rpmA: [...a.rpm],
    rpmB: [...b.rpm],
    positionXA: [...a.positionX],
    positionXB: [...b.positionX],
    positionZA: [...a.positionZ],
    positionZB: [...b.positionZ],
    yawA: [...a.yaw],
    yawB: [...b.yaw],
    elapsedTimeA: [...a.elapsedTimeS],
    elapsedTimeB: [...b.elapsedTimeS],
    tireWearA: a.tireWear ? Array.from(a.tireWear.FL, (v, i) => (v + a.tireWear!.FR[i]! + a.tireWear!.RL[i]! + a.tireWear!.RR[i]!) / 4) : undefined,
    tireWearB: b.tireWear ? Array.from(b.tireWear.FL, (v, i) => (v + b.tireWear!.FR[i]! + b.tireWear!.RL[i]! + b.tireWear!.RR[i]!) / 4) : undefined,
  };
  return { lapA, lapB, traces, timeDelta: traces.elapsedTimeA.map((v, i) => v - traces.elapsedTimeB[i]), corners: [], gameId: lapA.gameId };
}
export function useLapComparison(lapAId: number | null, lapBId: number | null) {
  const ids = lapAId != null && lapBId != null && lapAId !== lapBId ? [lapAId, lapBId] : [];
  const aligned = useAlignedTelemetry(ids, { step: 1 });
  const laps = useLaps().data ?? [];
  const lapA = laps.find((lap) => lap.id === lapAId);
  const lapB = laps.find((lap) => lap.id === lapBId);
  return { ...aligned, data: aligned.data && lapA && lapB ? alignedComparison(aligned.data, lapA, lapB) : undefined, isLoading: aligned.isLoading, error: aligned.error };
}
export function useLapComparisonRange(lapAId: number | null, lapBId: number | null, stepMeters: 0.1 | null, start: number | null, end: number | null) {
  const ids = lapAId != null && lapBId != null && lapAId !== lapBId ? [lapAId, lapBId] : [];
  const aligned = useAlignedTelemetry(ids, stepMeters === 0.1 && start != null && end != null ? { step: 0.1, start, end } : { step: 1 });
  const laps = useLaps().data ?? [];
  const lapA = laps.find((lap) => lap.id === lapAId);
  const lapB = laps.find((lap) => lap.id === lapBId);
  const data = aligned.data && lapA && lapB ? alignedComparison(aligned.data, lapA, lapB) : undefined;
  return {
    data: data
      ? {
          distanceStart: data.traces.distance[0] ?? 0,
          distanceEnd: data.traces.distance.at(-1) ?? 0,
          stepMeters: data.traces.distance[1] - data.traces.distance[0],
          traces: data.traces,
          timeDelta: data.timeDelta,
        }
      : undefined,
    isLoading: aligned.isLoading,
    isFetching: aligned.isFetching,
    isPlaceholderData: false,
    error: aligned.error,
  };
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
      if (lapId == null) throw new Error("Missing lap ID");
      if (!gameId) throw new Error("Missing game context");
      const res = await fetch(`/api/laps/${lapId}/semantic-telemetry`, { headers: { "X-Game-Id": gameId } });
      const body = (await res.json().catch(() => null)) as (SemanticLapTelemetry & { error?: string; parseError?: string }) | null;
      if (!res.ok || body?.parseError) {
        const message = body?.parseError ?? body?.error ?? res.statusText;
        const error = new Error(message) as SemanticTelemetryError;
        error.parseError = body?.parseError;
        throw error;
      }
      if (!body) throw new Error("Unable to replay telemetry");
      return body;
    },
    enabled: lapId != null && gameId != null,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
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
