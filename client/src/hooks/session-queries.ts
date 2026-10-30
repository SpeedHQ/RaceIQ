import type { RaceResult } from "@raceiq/shared/racing/results/types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { IRacingIncidentReport } from "@raceiq/shared/racing/sessions/iracing-incidents";
import type { ProcessingMetadata, SessionMeta, SessionRecap } from "@raceiq/shared/racing/sessions/types";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

const subscribeToVisibility = (onChange: () => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};

const getDocumentVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

export function usePendingMetadataRefetchInterval<T extends { processing: ProcessingMetadata }>() {
  const visible = useSyncExternalStore(subscribeToVisibility, getDocumentVisible, () => true);
  return useCallback((query: { state: { data?: readonly T[] } }) =>
    visible && query.state.data?.some(({ processing }) => processing.state === "queued" || processing.state === "processing")
      ? 2_000
      : false, [visible]);
}

export function indexProcessingById<T extends { id: number; processing: ProcessingMetadata }>(
  items: readonly T[] | undefined,
  ids: readonly number[],
): { isLoading: boolean; byId: ReadonlyMap<number, ProcessingMetadata> } {
  const requested = new Set(ids);
  const byId = new Map<number, ProcessingMetadata>();
  for (const item of items ?? []) {
    if (requested.has(item.id)) byId.set(item.id, item.processing);
  }
  return { isLoading: items === undefined, byId };
}


export function useSessions(options?: { allGames?: boolean }) {
  const gameId = useGameId();
  const { allGames = false } = options ?? {};
  const queryGameId = allGames ? null : gameId;
  return useQuery({
    queryKey: ["sessions", queryGameId],
    queryFn: async () => rpcJson<SessionMeta[]>(await client.api.sessions.$get({ query: { gameId: queryGameId ?? undefined } })),
    refetchInterval: usePendingMetadataRefetchInterval<SessionMeta>(),
    refetchIntervalInBackground: false,
  });
}

export function useSessionRecap(sessionId: number | null | undefined, gameId: GameId | null | undefined) {
  return useQuery({
    queryKey: ["session-recap", sessionId ?? null, gameId ?? null],
    queryFn: async () => {
      if (sessionId == null || !gameId) throw new Error("useSessionRecap: sessionId and gameId are required");
      const res = await client.api.sessions[":id"].recap.$get({ param: { id: String(sessionId) }, query: { gameId } });
      return rpcJson<SessionRecap>(res);
    },
    enabled: sessionId != null && !!gameId,
  });
}

export function useSessionResult(sessionId: number | null | undefined, gameId: GameId | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sessionResult(sessionId ?? null, gameId ?? null),
    queryFn: async () => {
      if (sessionId == null || !gameId) throw new Error("useSessionResult: sessionId and gameId are required");
      const response = await client.api.sessions[":id"].result.$get({
        param: { id: String(sessionId) },
        query: { gameId },
      });
      return rpcJson<RaceResult>(response);
    },
    enabled: enabled && sessionId != null && !!gameId,
  });
}

export function useIRacingIncidentReport(sessionId: number | null | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.iracingIncidentReport(sessionId ?? null),
    queryFn: async () => {
      if (sessionId == null) throw new Error("useIRacingIncidentReport: sessionId is required");
      return rpcJson<IRacingIncidentReport>(await client.api.iracing.sessions[":id"].incidents.$get({ param: { id: String(sessionId) } }));
    },
    enabled: enabled && sessionId != null,
  });
}
