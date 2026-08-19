import type { RaceResult } from "@shared/racing/results/types";
import type { RaceEventPage } from "@shared/racing/events/contracts";
import type {
  ComparableSessionRunPage,
  ComparableSessionRunQuery,
  SessionRunEvidencePage,
  SessionRunId,
  SessionRunLapPage,
  SessionRunLapQuery,
  SessionRunPage,
  SessionRunQuery,
} from "@shared/racing/runs/contracts";
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

export function useSessionRaceEvents(sessionId: number | null | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.sessionEvents(sessionId ?? null),
    queryFn: async ({ pageParam }) => {
      if (sessionId == null) throw new Error("useSessionRaceEvents: sessionId is required");
      const response = await client.api.sessions[":id"].events.$get({
        param: { id: String(sessionId) },
        query: {
          limit: "200",
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      return rpcJson<RaceEventPage>(response);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && sessionId != null,
  });
}

type SessionRunQueryInput = Partial<SessionRunQuery>;
type SessionRunLapQueryInput = Partial<SessionRunLapQuery>;
type ComparableSessionRunQueryInput = Partial<ComparableSessionRunQuery>;

function sessionRunQueryParams(query: SessionRunQueryInput, cursor?: string) {
  return {
    limit: String(query.limit ?? 200),
    ...(query.runKind ? { runKind: query.runKind } : {}),
    ...(query.participantId ? { participantId: query.participantId } : {}),
    ...(query.driverId ? { driverId: query.driverId } : {}),
    ...(query.observedPhase ? { observedPhase: query.observedPhase } : {}),
    ...(query.timelineEpoch != null
      ? { timelineEpoch: String(query.timelineEpoch) }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.overlapsRunId ? { overlapsRunId: query.overlapsRunId } : {}),
    ...(query.minCompletedLaps != null
      ? { minCompletedLaps: String(query.minCompletedLaps) }
      : {}),
    ...(query.maxCompletedLaps != null
      ? { maxCompletedLaps: String(query.maxCompletedLaps) }
      : {}),
    ...(query.qualityOnly != null
      ? { qualityOnly: String(query.qualityOnly) }
      : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function useSessionRuns(
  sessionId: number | null | undefined,
  query: SessionRunQueryInput = {},
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.sessionRuns(sessionId ?? null, query),
    queryFn: async ({ pageParam }) => {
      if (sessionId == null) {
        throw new Error("useSessionRuns: sessionId is required");
      }
      const response = await client.api.sessions[":id"].runs.$get({
        param: { id: String(sessionId) },
        query: sessionRunQueryParams(query, pageParam),
      });
      return rpcJson<SessionRunPage>(response);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && sessionId != null,
  });
}

export function useDriverStints(
  driverId: string | null | undefined,
  query: SessionRunQueryInput = {},
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.driverStints(driverId ?? null, query),
    queryFn: async ({ pageParam }) => {
      if (!driverId) throw new Error("useDriverStints: driverId is required");
      const response = await client.api.drivers[":driverId"].stints.$get({
        param: { driverId },
        query: sessionRunQueryParams(query, pageParam),
      });
      return rpcJson<SessionRunPage>(response);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && !!driverId,
  });
}

export function useSessionRunLaps(
  runId: SessionRunId | null | undefined,
  query: SessionRunLapQueryInput = {},
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.sessionRunLaps(runId ?? null, query),
    queryFn: async ({ pageParam }) => {
      if (!runId) throw new Error("useSessionRunLaps: runId is required");
      const response = await client.api["session-runs"][":runId"].laps.$get({
        param: { runId },
        query: {
          eligibilityPolicy: query.eligibilityPolicy ?? "normal-pace",
          limit: String(query.limit ?? 200),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      return rpcJson<SessionRunLapPage>(response);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && !!runId,
  });
}

export function useSessionRunEvidence(
  runId: SessionRunId | null | undefined,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.sessionRunEvidence(runId ?? null),
    queryFn: async ({ pageParam }) => {
      if (!runId) throw new Error("useSessionRunEvidence: runId is required");
      const response = await client.api["session-runs"][":runId"].evidence.$get({
        param: { runId },
        query: {
          limit: "200",
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      return rpcJson<SessionRunEvidencePage>(response);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && !!runId,
  });
}

export function useComparableSessionRuns(
  runId: SessionRunId | null | undefined,
  query: ComparableSessionRunQueryInput = {},
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: queryKeys.comparableSessionRuns(runId ?? null, query),
    queryFn: async ({ pageParam }) => {
      if (!runId) {
        throw new Error("useComparableSessionRuns: runId is required");
      }
      const response = await client.api["session-runs"][":runId"].comparable.$get({
        param: { runId },
        query: {
          limit: String(query.limit ?? 200),
          ...(query.participantId
            ? { participantId: query.participantId }
            : {}),
          ...(query.driverId ? { driverId: query.driverId } : {}),
          ...(query.classId ? { classId: query.classId } : {}),
          ...(query.gameId ? { gameId: query.gameId } : {}),
          ...(query.trackId ? { trackId: query.trackId } : {}),
          ...(query.observedPhase
            ? { observedPhase: query.observedPhase }
            : {}),
          ...(query.requireEnvironmentEvidence != null
            ? {
                requireEnvironmentEvidence: String(
                  query.requireEnvironmentEvidence,
                ),
              }
            : {}),
          ...(query.minCompletedLaps != null
            ? { minCompletedLaps: String(query.minCompletedLaps) }
            : {}),
          ...(query.maxCompletedLaps != null
            ? { maxCompletedLaps: String(query.maxCompletedLaps) }
            : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      return rpcJson<ComparableSessionRunPage>(response);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: enabled && !!runId,
  });
}
