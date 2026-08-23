import type { RaceResult } from "@shared/racing/results/types";
import type { RaceEventPage } from "@shared/racing/events/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
    queryFn: async () => {
      if (!gameId) throw new Error("useSessions: gameId is required");
      return rpcJson<SessionMeta[]>(await client.api.sessions.$get({ query: { gameId } }));
    },
    enabled: !!gameId,
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

export async function fetchSessionRaceEventPage(
  sessionId: number,
  gameId: GameId,
  cursor?: string,
  limit = 200,
  signal?: AbortSignal,
): Promise<RaceEventPage> {
  const response = await client.api.sessions[":id"].events.$get(
    {
      param: { id: String(sessionId) },
      query: {
        gameId,
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      },
    },
    { init: { signal } },
  );
  return rpcJson<RaceEventPage>(response);
}

export function useSessionRaceEvents(sessionId: number | null | undefined, gameId: GameId | null | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.sessionEvents(sessionId ?? null, gameId ?? null),
    queryFn: ({ pageParam }) => {
      if (sessionId == null || !gameId) throw new Error("useSessionRaceEvents: sessionId and gameId are required");
      return fetchSessionRaceEventPage(sessionId, gameId, pageParam);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && sessionId != null && !!gameId,
  });
}
