import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { OpponentDataErrorCode, OpponentLapCatalog, OpponentLapComparison, OpponentComparisonRequest, OpponentLapReference, OpponentSemanticLapTelemetry } from "@raceiq/lap-replay/contracts";
import { client } from "../lib/rpc";
function useRefreshOpponentCatalogOnIndexError(playerLapId: number | null, error: unknown) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (playerLapId == null || !(error instanceof OpponentQueryError) ||
      !["OPPONENT_INDEX_NOT_READY", "OPPONENT_INDEX_FAILED", "SOURCE_CHANGED", "OPPONENT_DATA_REMOVED", "OPPONENT_DATA_UNAVAILABLE", "OPPONENT_LAP_NOT_FOUND"].includes(error.code ?? "")) return;
    void queryClient.invalidateQueries({ queryKey: ["opponent-lap-catalog", playerLapId] });
  }, [error, playerLapId, queryClient]);
}

export class OpponentQueryError extends Error {
  readonly code: OpponentDataErrorCode | null;
  constructor(message: string, code: OpponentDataErrorCode | null) {
    super(message);
    this.name = "OpponentQueryError";
    this.code = code;
  }
}

async function responseJson<T>(response: Pick<Response, "ok" | "json" | "statusText">): Promise<T> {
  const payload: unknown = await response.json();
  if (response.ok) return payload as T;
  const body = payload && typeof payload === "object" ? payload as { code?: unknown; error?: unknown } : {};
  const code = typeof body.code === "string" ? body.code as OpponentDataErrorCode : null;
  throw new OpponentQueryError(typeof body.error === "string" ? body.error : response.statusText, code);
}

export function useOpponentLapCatalog(playerLapId: number | null) {
  return useQuery({
    queryKey: ["opponent-lap-catalog", playerLapId],
    enabled: playerLapId != null,
    queryFn: async (): Promise<OpponentLapCatalog> => {
      if (playerLapId == null) throw new Error("Player lap required");
      const response = await client.api.laps[":id"]["opponent-laps"].$get({ param: { id: String(playerLapId) } }, { headers: { "X-Game-Id": "lmu" } });
      return responseJson<OpponentLapCatalog>(response);
    },
    refetchInterval: (query) => query.state.data?.indexState === "queued" || query.state.data?.indexState === "building" ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useOpponentLapComparison(playerLapId: number | null, request: OpponentComparisonRequest | null) {
  const query = useQuery({
    queryKey: ["opponent-lap-comparison", playerLapId, request],
    enabled: playerLapId != null && request != null,
    queryFn: async (): Promise<OpponentLapComparison> => {
      if (playerLapId == null || request == null) throw new Error("Opponent comparison identity required");
      const response = await client.api.laps[":id"]["opponent-comparison"].$post({
        param: { id: String(playerLapId) },
        json: request,
      }, { headers: { "X-Game-Id": "lmu" } });
      return responseJson<OpponentLapComparison>(response);
    },
  });
  useRefreshOpponentCatalogOnIndexError(playerLapId, query.error);
  return query;
}

export function useOpponentLapSemanticTelemetry(reference: OpponentLapReference | null) {
  const opponent = reference?.kind === "opponent" ? reference : null;
  const query = useQuery({
    queryKey: ["opponent-semantic-telemetry", opponent],
    enabled: opponent != null,
    queryFn: async (): Promise<OpponentSemanticLapTelemetry> => {
      if (opponent == null) throw new Error("Opponent replay reference required");
      const response = await client.api.laps[":id"]["opponent-laps"][":opponentLapId"]["semantic-telemetry"].$get({
        param: { id: String(opponent.playerLapId), opponentLapId: opponent.opponentLapId },
        query: { sourceRevision: opponent.sourceRevision },
      }, { headers: { "X-Game-Id": "lmu" } });
      return responseJson<OpponentSemanticLapTelemetry>(response);
    },
  });
  useRefreshOpponentCatalogOnIndexError(opponent?.playerLapId ?? null, query.error);
  return query;
}
