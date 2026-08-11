import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DriverProfileSummary } from "../../../server/ai/schemas";
import type { DriverFingerprint } from "../../../server/driver-profile/fingerprint";
import type { GameId } from "../../../shared/games/ids";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

export interface DriverProfileResponse {
  fingerprint: DriverFingerprint;
  gameName: string;
}
export type DriverProfileRunStatus = "queued" | "running" | "succeeded" | "failed";
export type DriverProfileState = DriverProfileRunStatus | "disabled" | "not-configured";

export interface DriverProfileRun {
  id: number;
  scopeKey: string;
  gameId: GameId;
  carOrdinal: number | null;
  trackOrdinal: number | null;
  poolKey: string;
  status: DriverProfileRunStatus;
  fingerprint: string | null;
  plan: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DriverProfileRunsResponse {
  scope: { gameId: GameId };
  gameName: string;
  state: DriverProfileState;
  enabled: boolean;
  configured: boolean;
  reason?: string;
  latest: DriverProfileRun | null;
  runs: DriverProfileRun[];
}

export interface DriverProfileRunMutationResponse {
  scope: DriverProfileRunsResponse["scope"];
  gameName: string;
  state: DriverProfileState;
  run: DriverProfileRun | null;
  summary?: DriverProfileSummary;
  fingerprint?: DriverFingerprint;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string };
  error?: string;
}

export interface DriverProfileRunScope {
  gameId?: GameId | null;
}

export function useDriverProfileRuns(scope?: DriverProfileRunScope) {
  const storeGameId = useGameId();
  const gameId = scope?.gameId ?? storeGameId;
  return useQuery({
    queryKey: queryKeys.driverProfileRuns(gameId),
    queryFn: async () => {
      if (!gameId) throw new Error("Missing game context");
      const res = await client.api.drivers.profile.runs.$get({ query: { limit: "50" } }, { headers: { "X-Game-Id": gameId } });
      return rpcJson<DriverProfileRunsResponse>(res);
    },
    enabled: !!gameId,
    refetchInterval: (query) => {
      const status = query.state.data?.latest?.status;
      return status === "queued" || status === "running" ? 2_000 : false;
    },
  });
}

export function useRunDriverProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ gameId, retry = false }: { gameId: GameId; retry?: boolean }) => {
      const res = await client.api.drivers.profile.runs.$post({ query: { runNow: retry ? undefined : "true", retry: retry ? "true" : undefined } }, { headers: { "X-Game-Id": gameId } });
      return rpcJson<DriverProfileRunMutationResponse>(res);
    },
    onSettled: (_data, _error, variables) => {
      void qc.invalidateQueries({ queryKey: queryKeys.driverProfileRuns(variables.gameId) });
      void qc.invalidateQueries({ queryKey: queryKeys.driverProfile(variables.gameId) });
    },
  });
}

export function useDriverProfile(scope?: { gameId?: GameId | null }) {
  const storeGameId = useGameId();
  const gameId = scope?.gameId ?? storeGameId;
  return useQuery({
    queryKey: queryKeys.driverProfile(gameId),
    queryFn: async () => {
      if (!gameId) throw new Error("Missing game context");
      const res = await client.api.drivers.profile.$get({ query: {} }, { headers: { "X-Game-Id": gameId } });
      return rpcJson<DriverProfileResponse>(res);
    },
    enabled: !!gameId,
  });
}
