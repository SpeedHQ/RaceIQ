import type { RaceResult } from "@shared/racing/results/types";
import { useQuery } from "@tanstack/react-query";
import type { GameId } from "../../../shared/games/ids";
import type { SessionMeta, SessionRecap } from "../../../shared/racing/sessions/types";
import { client } from "../lib/rpc";
import { rpcJson } from "../lib/rpc-json";
import { useGameId } from "../stores/game";
import { queryKeys } from "./query-keys";

export function useSessions() {
  const gameId = useGameId();
  return useQuery({
    queryKey: ["sessions", gameId ?? null],
    queryFn: async () => rpcJson<SessionMeta[]>(await client.api.sessions.$get({ query: { gameId: gameId ?? undefined } })),
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
