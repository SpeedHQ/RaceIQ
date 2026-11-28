import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LineSpreadTrace } from "@raceiq/analysis-core/racing/laps/consistency-types";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { ComparisonData, AlignedTrace } from "@raceiq/shared/racing/comparison/types";
import type { AlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/types";
import type { LapInsight } from "@raceiq/analysis-core/racing/analysis/laps/insights/types"
import { useAlignedTelemetry } from "./aligned-telemetry";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";
import { usePendingMetadataRefetchInterval } from "./session-queries";
import { invalidateDashboardQueries } from "./dashboard";
import { decodeBackgroundLapTelemetry, decodeSemanticLapTelemetry, MOTION_REPLAY_MEDIA_TYPE, SEMANTIC_REPLAY_MEDIA_TYPE, type SemanticLapTelemetry } from "@raceiq/lap-replay/contracts";

export function useLaps(options?: { refetchInterval?: number | false; allGames?: boolean; enabled?: boolean }) {
  const gameId = useGameId();
  const { allGames = false, refetchInterval, ...queryOptions } = options ?? {};
  const queryGameId = allGames ? null : gameId;
  const pendingRefetchInterval = usePendingMetadataRefetchInterval<LapMeta>();
  return useQuery({
    queryKey: ["laps", queryGameId],
    queryFn: async () => {
      const res = await client.api.laps.$get({ query: { gameId: queryGameId ?? undefined } });
      return rpcJson<LapMeta[]>(res);
    },
    refetchInterval: refetchInterval ?? pendingRefetchInterval,
    refetchIntervalInBackground: false,
    ...queryOptions,
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
    refetchInterval: usePendingMetadataRefetchInterval<LapMeta>(),
    refetchIntervalInBackground: false,
  });
}


export function useCompareLineSpread(gameId: GameId, lapIds: readonly number[], enabled = true) {
  const activeGameId = useGameId();
  const orderedIds = useMemo(() => [...lapIds], [lapIds]);
  const lapsQuery = useLaps();
  const canRead = gameId === activeGameId && canReadLapMetadata(lapsQuery.data, lapsQuery.isError, orderedIds);
  const query = useQuery({
    queryKey: ["compare-line-spread", gameId, orderedIds],
    queryFn: async () => {
      const res = await client.api.laps["compare-line-spread"].$get({
        query: { gameId, lapIds: orderedIds.join(",") },
      });
      if (!res.ok) throw await errorFromResponse(res);
      return res.json() as Promise<LineSpreadTrace | null>;
    },
    enabled: enabled && canRead && !!gameId && orderedIds.length === 2 && orderedIds[0] !== orderedIds[1],
  });
  useRefreshProcessingMetadataOnError(query.error);
  return { ...query, data: isProcessingReadinessError(query.error) ? undefined : query.data };
}
function alignedComparison(set: AlignedLapSet, lapA: LapMeta, lapB: LapMeta): ComparisonData {
  const a = set.laps[0]!,
    b = set.laps[1]!;
  const traces: AlignedTrace = {
    distance: [...set.distanceMeters],
    sourceIndicesA: [...a.sourceIndices],
    sourceIndicesB: [...b.sourceIndices],
    speedA: Array.from(a.speedMps, (v) => v * 2.236936),
    speedB: Array.from(b.speedMps, (v) => v * 2.236936),
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
  const lapsQuery = useLaps();
  const canRead = canReadLapMetadata(lapsQuery.data, lapsQuery.isError, ids);
  const aligned = useAlignedTelemetry(canRead ? ids : [], { step: 1 });
  useRefreshProcessingMetadataOnError(aligned.error);
  const laps = lapsQuery.data ?? [];
  const lapA = laps.find((lap) => lap.id === lapAId);
  const lapB = laps.find((lap) => lap.id === lapBId);
  const data = useMemo(
    () => !isProcessingReadinessError(aligned.error) && aligned.data && lapA && lapB ? alignedComparison(aligned.data, lapA, lapB) : undefined,
    [aligned.data, aligned.error, lapA, lapB],
  );
  return { ...aligned, data, isLoading: aligned.isLoading, error: aligned.error };
}
export function useLapComparisonRange(lapAId: number | null, lapBId: number | null, stepMeters: 0.1 | null, start: number | null, end: number | null) {
  const ids = lapAId != null && lapBId != null && lapAId !== lapBId ? [lapAId, lapBId] : [];
  const lapsQuery = useLaps();
  const canRead = canReadLapMetadata(lapsQuery.data, lapsQuery.isError, ids);
  const aligned = useAlignedTelemetry(
    canRead ? ids : [],
    stepMeters === 0.1 && start != null && end != null ? { step: 0.1, start, end } : null,
  );
  useRefreshProcessingMetadataOnError(aligned.error);
  const laps = lapsQuery.data ?? [];
  const lapA = laps.find((lap) => lap.id === lapAId);
  const lapB = laps.find((lap) => lap.id === lapBId);
  const data = useMemo(() => {
    if (isProcessingReadinessError(aligned.error) || !aligned.data || !lapA || !lapB) return undefined;
    const { traces, timeDelta } = alignedComparison(aligned.data, lapA, lapB);
    return {
      distanceStart: traces.distance[0] ?? 0,
      distanceEnd: traces.distance.at(-1) ?? 0,
      stepMeters: traces.distance[1] - traces.distance[0],
      traces,
      timeDelta,
    };
  }, [aligned.data, aligned.error, lapA, lapB]);
  return {
    data,
    isLoading: aligned.isLoading,
    isFetching: aligned.isFetching,
    isPlaceholderData: aligned.isPlaceholderData,
    error: aligned.error,
  };
}

type ProcessingReadinessError = Error & {
  status: 409 | 422;
  code: "RECORDING_PROCESSING" | "RECORDING_PROCESSING_FAILED";
};

export function isProcessingReadinessError(error: unknown): error is ProcessingReadinessError {
  if (!(error instanceof Error)) return false;
  const { status, code } = error as ProcessingReadinessError;
  return (status === 409 && code === "RECORDING_PROCESSING") ||
    (status === 422 && code === "RECORDING_PROCESSING_FAILED");
}

function canReadLapMetadata(laps: readonly LapMeta[] | undefined, isError: boolean, lapIds: readonly number[]) {
  return laps !== undefined && !isError && lapIds.every((id) => {
    const lap = laps.find((candidate) => candidate.id === id);
    return lap == null || lap.processing.state === "ready";
  });
}

function invalidateProcessingMetadata(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
    queryClient.invalidateQueries({ queryKey: ["session-laps"] }),
    queryClient.invalidateQueries({ queryKey: ["aligned-telemetry"] }),
  ]);
}

function useRefreshProcessingMetadataOnError(error: unknown) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isProcessingReadinessError(error)) return;
    void invalidateProcessingMetadata(queryClient);
  }, [error, queryClient]);
}


interface SemanticTelemetryError extends Error {
  parseError?: string;
  status?: number;
  code?: string;
}

/** Canonical semantic replay; unlike useLapTelemetry this never exposes native packets. */
export function useLapSemanticTelemetry(lapId: number | null, sessionId?: number, motionOnly = false) {
  const gameId = useGameId();
  const queryClient = useQueryClient();
  const gameLaps = useLaps({ enabled: sessionId == null && lapId != null });
  const sessionLaps = useSessionLaps(sessionId ?? null);
  const lapsQuery = sessionId == null ? gameLaps : sessionLaps;
  const metadataReady = lapId != null && gameId != null && canReadLapMetadata(lapsQuery.data, lapsQuery.isError, [lapId]);
  const fullKey = ["lap-semantic-telemetry", lapId, gameId ?? null];
  const cachedFull = motionOnly ? queryClient.getQueryData<SemanticLapTelemetry>(fullKey) : undefined;
  const query = useQuery({
    queryKey: motionOnly ? [...fullKey, "motion"] : fullKey,
    // Keep replay work alive across view/page changes so new observers await it.
    queryFn: async () => {
      if (lapId == null) throw new Error("Missing lap ID");
      if (!gameId) throw new Error("Missing game context");
      const res: Pick<Response, "ok" | "status" | "statusText" | "json"> = await client.api.laps[":id"]["semantic-telemetry"].$get({ param: { id: String(lapId) } }, { headers: { "X-Game-Id": gameId, Accept: motionOnly ? MOTION_REPLAY_MEDIA_TYPE : SEMANTIC_REPLAY_MEDIA_TYPE } });
      const body = (await res.json().catch(() => null)) as { code?: string; error?: string; parseError?: string } | null;
      if (!res.ok || body?.parseError) {
        const error = new Error(body?.parseError ?? body?.error ?? res.statusText) as SemanticTelemetryError;
        error.parseError = body?.parseError;
        error.status = res.status;
        error.code = body?.code;
        throw error;
      }
      if (!body) throw new Error("Unable to replay telemetry");
      return motionOnly ? decodeSemanticLapTelemetry(body, { consume: true }) : decodeBackgroundLapTelemetry(body);
    },
    enabled: metadataReady && !cachedFull,
    gcTime: sessionId == null && !motionOnly ? 5 * 60 * 1000 : 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: (current) => isProcessingReadinessError(current.state.error) ? "always" : false,
  });
  useEffect(() => {
    if (!isProcessingReadinessError(query.error) || lapId == null || gameId == null) return;
    void Promise.all([
      invalidateProcessingMetadata(queryClient),
      queryClient.invalidateQueries({
        queryKey: ["lap-semantic-telemetry", lapId, gameId],
        refetchType: "none",
      }),
    ]).then(() => {
      const latestLaps = queryClient.getQueryData<LapMeta[]>(sessionId == null ? ["laps", gameId] : ["session-laps", gameId, sessionId]);
      if (latestLaps && canReadLapMetadata(latestLaps, false, [lapId])) void query.refetch();
    });
  }, [gameId, lapId, sessionId, query.error, query.refetch, queryClient]);
  const metadataError = lapsQuery.error;
  const blocked = lapId != null && !metadataReady;
  const showTelemetry = !blocked && !isProcessingReadinessError(query.error);
  return {
    ...query,
    data: showTelemetry ? query.data ?? cachedFull : undefined,
    error: metadataError ?? query.error,
    isLoading: blocked ? !lapsQuery.isError : query.isLoading,
  };
}

/** Findings only; avoids loading full semantic replay in session Analyse. */
export function useLapInsights(lapId: number | null) {
  const gameId = useGameId();
  const lapsQuery = useLaps();
  const canRead = lapId != null && gameId != null && canReadLapMetadata(lapsQuery.data, lapsQuery.isError, [lapId]);
  const query = useQuery({
    queryKey: ["lap-insights", lapId, gameId ?? null],
    queryFn: async () => {
      const res = await fetch(`/api/laps/${lapId}/insights`, { headers: { "X-Game-Id": gameId! } });
      if (!res.ok) throw await errorFromResponse(res);
      return (await res.json() as { insights: LapInsight[] }).insights;
    },
    enabled: canRead,
  });
  useRefreshProcessingMetadataOnError(query.error);
  return { ...query, data: canRead && !isProcessingReadinessError(query.error) ? query.data : undefined };
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
      qc.invalidateQueries({ queryKey: queryKeys.userTunes });
      invalidateDashboardQueries();
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
      qc.invalidateQueries({ queryKey: queryKeys.userTunes });
      invalidateDashboardQueries();
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
      qc.invalidateQueries({ queryKey: queryKeys.userTunes });
      if (experimentId != null) {
        qc.invalidateQueries({ queryKey: ["experiment", experimentId] });
        qc.invalidateQueries({ queryKey: ["experiment-tests", experimentId] });
        qc.invalidateQueries({ queryKey: ["experiment-chat-history", experimentId] });
      }
    },
  });
}
