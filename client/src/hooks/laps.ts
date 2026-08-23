import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { FindingGenerationReceipt, FindingNarrative, FindingRecommendation, FindingRecord } from "../../../shared/racing/findings/types";
import type { ChannelQualitySummary, EligibilityDecision } from "../../../shared/racing/quality/contracts";
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
  findings: FindingRecord[];
  narratives: FindingNarrative[];
  recommendations: FindingRecommendation[];
  findingReceipt: FindingGenerationReceipt;
  parseError?: string | null;
  decision: EligibilityDecision;
  qualityGeneration: string | null;
  /** Fidelity, freshness, units, issue intervals, and source limitations for replayed semantic channels. */
  channelQuality: ChannelQualitySummary[];
  envelopes: SemanticReplayFrame[];
}

interface SemanticTelemetryError extends Error {
  parseError?: string;
  statusCode?: number;
  retryable?: boolean;
  pendingStatus?: string;
}

const MAX_FINDING_POLLS = 20;
const FINDING_POLL_MS = 1500;

/** Canonical semantic replay; unlike useLapTelemetry this never exposes native packets. */
export function useLapSemanticTelemetry(lapId: number | null) {
  const gameId = useGameId();
  const queryClient = useQueryClient();
  const pendingPolls = useRef(0);
  const pendingInvalidated = useRef(false);
  const pendingIdentityRef = useRef("");
  const semanticIdentity = `${lapId ?? ""}:${gameId ?? ""}`;
  if (pendingIdentityRef.current !== semanticIdentity) {
    pendingIdentityRef.current = semanticIdentity;
    pendingPolls.current = 0;
    pendingInvalidated.current = false;
  }
  useEffect(() => {
    pendingPolls.current = 0;
    pendingInvalidated.current = false;
  }, [gameId, lapId]);
  const query = useQuery({
    queryKey: ["lap-semantic-telemetry", lapId, gameId ?? null],
    queryFn: async () => {
      if (!gameId) throw new Error("Missing game context");
      const res = await client.api.laps[":id"]["semantic-telemetry"].$get(
        { param: { id: String(lapId) } },
        { headers: { "X-Game-Id": gameId } },
      );
      if (!res.ok) {
        const pending = res.status === 409
          ? await res.clone().json().catch(() => null) as { error?: string; status?: string; retryable?: boolean } | null
          : null;
        if (res.status === 409 && pending?.status === "backfilling" && pending.retryable === true) {
          pendingPolls.current++;
          const error = new Error(pending.error ?? "Finding generation is backfilling") as SemanticTelemetryError;
          error.statusCode = 409;
          error.retryable = pendingPolls.current <= MAX_FINDING_POLLS;
          error.pendingStatus = pending.status;
          throw error;
        }
        throw await errorFromResponse(res);
      }
      pendingPolls.current = 0;
      pendingInvalidated.current = false;
      const body = await rpcJson<SemanticLapTelemetry & { error?: string }>(res);
      if (body.parseError) {
        const error = new Error(body.parseError ?? body.error ?? res.statusText) as SemanticTelemetryError;
        error.parseError = body.parseError;
        throw error;
      }
      return body;
    },
    enabled: lapId != null && gameId != null,
    retry: false,
    refetchInterval: (currentQuery) => {
      const error = currentQuery.state.error as SemanticTelemetryError | null;
      return error?.retryable === true && pendingPolls.current <= MAX_FINDING_POLLS ? FINDING_POLL_MS : false;
    },
    gcTime: 0,
    staleTime: 0,
  });
  useEffect(() => {
    const error = query.error as SemanticTelemetryError | null;
    if (!error?.retryable || pendingInvalidated.current) return;
    pendingInvalidated.current = true;
    void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
  }, [query.error, queryClient]);
  return query;
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
    mutationFn: async ({ lapId, excluded, experimentId }: { lapId: number; excluded: boolean; experimentId: number }) => {
      const res = await client.api.laps[":id"]["experiment-excluded"].$post({
        param: { id: String(lapId) },
        json: { experimentId, excluded },
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
