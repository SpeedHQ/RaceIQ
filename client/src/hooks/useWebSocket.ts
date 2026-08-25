import { useEffect, useRef } from "react";
import type { GameId } from "@shared/games/ids";
import { RaceEventsAppendedMessageSchema, RaceEventsReplacedMessageSchema } from "@shared/racing/events/contracts";
import { SessionRunsCompletedMessageSchema, SessionRunsReplacedMessageSchema } from "@shared/racing/runs/contracts";
import { mergeAppendedRaceEvents, mergeRecoveredRaceEventPage, recoverRaceEventTail, type RaceEventInfiniteData } from "../lib/race-event-cache";
import { queryClient } from "../lib/queryClient";
import { client } from "../lib/rpc";
import { handleWebSocketMessage } from "../lib/websocket-messages";
import { fetchSessionRaceEventPage } from "./session-queries";
import type { VersionInfo } from "../stores/telemetry";
import { useTelemetryStore } from "../stores/telemetry";
import { useDevTelemetryStore } from "../stores/dev-telemetry";
import { isComparableSessionRunQueryKey, qualityUpdatedQueryKeys, queryKeys, sessionRunsUpdatedQueryKeys } from "./query-keys";
import { buildWebSocketUrl, type DevWebSocketTarget } from "./websocket-url";

declare const __RACEIQ_DEV_WS_TARGET__: DevWebSocketTarget;

const VERSION_REQUEST_TIMEOUT_MS = 10_000;
const RACE_RESULT_REPROCESS_ERROR = "One or more race results could not be reconciled.";

function fetchVersionInfo(signal: AbortSignal) {
  return client.api.version
    .$get(undefined, { init: { signal } })
    .then((r) => r.json())
    .then((d) => {
      if (!signal.aborted) useTelemetryStore.getState().setVersionInfo(d as unknown as VersionInfo);
    })
    .catch(() => {});
}

function isRaceEventInfiniteData(value: unknown): value is RaceEventInfiniteData {
  return typeof value === "object" && value != null && "pages" in value && Array.isArray(value.pages);
}

function raceEventCacheEntries(sessionId?: number): Array<{ queryKey: readonly unknown[]; sessionId: number; gameId: GameId }> {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.sessionEventTimelines })
    .flatMap((query) => {
      const [scope, cachedSessionId, cachedGameId] = query.queryKey;
      if (scope !== "session-events" || typeof cachedSessionId !== "number" || typeof cachedGameId !== "string") return [];
      if (sessionId != null && cachedSessionId !== sessionId) return [];
      return [{ queryKey: query.queryKey, sessionId: cachedSessionId, gameId: cachedGameId as GameId }];
    });
}
export function mergeAppendedRaceEventsIntoCaches(sessionId: number, events: RaceEventInfiniteData["pages"][number]["items"]) {
  for (const { queryKey } of raceEventCacheEntries(sessionId)) {
    queryClient.setQueryData(queryKey, (data: unknown) => (isRaceEventInfiniteData(data) ? mergeAppendedRaceEvents(data, events) : data));
  }
}

interface RaceEventRecovery {
  sessionId: number;
  generation: number;
  controller: AbortController;
}

const raceEventRecoveries = new Map<string, RaceEventRecovery>();
const raceEventRecoveryGenerations = new Map<string, number>();

function raceEventRecoveryKey(sessionId: number, gameId: GameId): string {
  return `${sessionId}:${gameId}`;
}

function startRaceEventRecovery(sessionId: number, gameId: GameId): RaceEventRecovery {
  const key = raceEventRecoveryKey(sessionId, gameId);
  const previous = raceEventRecoveries.get(key);
  previous?.controller.abort();
  const recovery = {
    sessionId,
    generation: (raceEventRecoveryGenerations.get(key) ?? 0) + 1,
    controller: new AbortController(),
  };
  raceEventRecoveryGenerations.set(key, recovery.generation);
  raceEventRecoveries.set(key, recovery);
  return recovery;
}

function isCurrentRaceEventRecovery(sessionId: number, gameId: GameId, recovery: RaceEventRecovery): boolean {
  return raceEventRecoveries.get(raceEventRecoveryKey(sessionId, gameId)) === recovery && !recovery.controller.signal.aborted;
}

function cancelRaceEventRecoveries(sessionId?: number): void {
  for (const [key, recovery] of raceEventRecoveries) {
    if (sessionId != null && recovery.sessionId !== sessionId) continue;
    recovery.controller.abort();
    raceEventRecoveries.delete(key);
  }
}

async function resetRaceEventCache(queryKey: readonly unknown[]): Promise<void> {
  await queryClient.resetQueries({ queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" });
}

export async function recoverRaceEventTails(sessionId?: number): Promise<void> {
  await Promise.all(
    raceEventCacheEntries(sessionId).map(async ({ queryKey, sessionId: cachedSessionId, gameId }) => {
      const recovery = startRaceEventRecovery(cachedSessionId, gameId);
      try {
        const initial = queryClient.getQueryData(queryKey);
        if (!isRaceEventInfiniteData(initial) || initial.pages.length === 0) return;
        const initialPageCount = initial.pages.length;
        let recovered = initial;
        if (recovered.pages.at(-1)?.tailCursor == null) {
          const firstPage = await fetchSessionRaceEventPage(cachedSessionId, gameId, undefined, 1_000, recovery.controller.signal);
          if (!isCurrentRaceEventRecovery(cachedSessionId, gameId, recovery)) return;
          recovered = mergeRecoveredRaceEventPage(recovered, firstPage);
        }
        recovered = await recoverRaceEventTail(recovered, (cursor, signal) => fetchSessionRaceEventPage(cachedSessionId, gameId, cursor, 1_000, signal), recovery.controller.signal);
        if (!isCurrentRaceEventRecovery(cachedSessionId, gameId, recovery)) return;
        const recoveredPages = recovered.pages.length === initialPageCount ? [recovered.pages[recovered.pages.length - 1]!] : recovered.pages.slice(initialPageCount);
        queryClient.setQueryData(queryKey, (data: unknown) => {
          if (!isRaceEventInfiniteData(data)) return data;
          return recoveredPages.reduce(mergeRecoveredRaceEventPage, data);
        });
      } catch {
        if (isCurrentRaceEventRecovery(cachedSessionId, gameId, recovery)) {
          await resetRaceEventCache(queryKey);
        }
      } finally {
        if (raceEventRecoveries.get(raceEventRecoveryKey(cachedSessionId, gameId)) === recovery) {
          raceEventRecoveries.delete(raceEventRecoveryKey(cachedSessionId, gameId));
        }
      }
    }),
  );
}

export async function resetRaceEventCaches(sessionId: number): Promise<void> {
  cancelRaceEventRecoveries(sessionId);
  await queryClient.resetQueries({ queryKey: queryKeys.sessionEventsForSession(sessionId) });
  await queryClient.invalidateQueries({ queryKey: queryKeys.sessionEventsForSession(sessionId), refetchType: "active" });
}

export function handleRaceEventsReplaced(sessionId: number): Promise<void> {
  return resetRaceEventCaches(sessionId);
}

export async function handleLapSaved(sessionId: number): Promise<void> {
  await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.laps }), resetRaceEventCaches(sessionId)]);
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const packetCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const versionRequestControllerRef = useRef<AbortController | null>(null);
  const versionRequestTimeoutRef = useRef<number | undefined>(undefined);
  const hasOpenedRef = useRef(false);

  useEffect(() => {
    const abortVersionRequest = () => {
      if (versionRequestTimeoutRef.current !== undefined) {
        window.clearTimeout(versionRequestTimeoutRef.current);
        versionRequestTimeoutRef.current = undefined;
      }
      versionRequestControllerRef.current?.abort();
      versionRequestControllerRef.current = null;
    };

    const startVersionRequest = () => {
      abortVersionRequest();

      const controller = new AbortController();
      versionRequestControllerRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), VERSION_REQUEST_TIMEOUT_MS);
      versionRequestTimeoutRef.current = timeout;

      fetchVersionInfo(controller.signal).finally(() => {
        if (versionRequestControllerRef.current === controller) {
          versionRequestControllerRef.current = null;
        }
        if (versionRequestTimeoutRef.current === timeout) {
          window.clearTimeout(timeout);
          versionRequestTimeoutRef.current = undefined;
        }
      });
    };

    function connect() {
      abortVersionRequest();
      // Close any existing connection before opening a new one
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect loop
        wsRef.current.close();
        wsRef.current = null;
      }

      const devTarget = import.meta.env.DEV ? __RACEIQ_DEV_WS_TARGET__ : undefined;
      const ws = new WebSocket(buildWebSocketUrl(window.location, devTarget));
      wsRef.current = ws;

      // Read store actions via getState() — stable, no dependency issues
      const store = useTelemetryStore.getState();

      ws.onopen = () => {
        store.setConnected(true);
        startVersionRequest();
        if (hasOpenedRef.current) {
          void recoverRaceEventTails().catch((error) => console.error("Race-event tail recovery failed", error));
          void queryClient.invalidateQueries({
            queryKey: queryKeys.sessionRunPages,
            refetchType: "active",
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.sessionRunDetails,
            refetchType: "active",
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.driverStintPages,
            refetchType: "active",
          });
        }
        hasOpenedRef.current = true;
        if (useDevTelemetryStore.getState().subscriptionWanted) {
          ws.send(JSON.stringify({ type: "subscribe", channel: "dev-telemetry" }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "race-events-appended") {
            const raceEventMessage = RaceEventsAppendedMessageSchema.safeParse(data);
            if (raceEventMessage.success) {
              mergeAppendedRaceEventsIntoCaches(raceEventMessage.data.sessionId, raceEventMessage.data.events);
            }
          } else if (data.type === "race-events-replaced") {
            const raceEventMessage = RaceEventsReplacedMessageSchema.safeParse(data);
            if (raceEventMessage.success) {
              void handleRaceEventsReplaced(raceEventMessage.data.sessionId).catch((error) => console.error("Race-event replacement recovery failed", error));
            }
          } else if (data.type === "session-runs-completed" || data.type === "session-runs-replaced") {
            const sessionRunMessage = data.type === "session-runs-completed" ? SessionRunsCompletedMessageSchema.safeParse(data) : SessionRunsReplacedMessageSchema.safeParse(data);
            if (sessionRunMessage.success) {
              const runIds = sessionRunMessage.data.type === "session-runs-completed" ? sessionRunMessage.data.runs.map(({ runId }) => runId) : [];
              for (const queryKey of sessionRunsUpdatedQueryKeys(sessionRunMessage.data.sessionId, runIds)) {
                void queryClient.invalidateQueries({ queryKey });
              }
              if (sessionRunMessage.data.type === "session-runs-completed") {
                void queryClient.invalidateQueries({
                  predicate: ({ queryKey }) => isComparableSessionRunQueryKey(queryKey),
                });
              }
              if (sessionRunMessage.data.type === "session-runs-replaced") {
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.sessionRunDetails,
                });
              }
            }
          } else if (data.type === "status") {
            const { type: __ignored, ...status } = data; // eslint-disable-line @typescript-eslint/no-unused-vars
            useTelemetryStore.getState().setServerStatus(status);
          } else if (data.type === "update-available") {
            useTelemetryStore.getState().setUpdateAvailable(data.version as string);
            startVersionRequest();
          } else if (data.type === "update-progress") {
            useTelemetryStore.getState().setUpdateProgress({ stage: data.stage, percent: data.percent ?? 0 });
          } else if (data.type === "onboarding_complete") {
            queryClient.invalidateQueries({ queryKey: ["settings"] });
          } else if (data.type === "session-laps") {
            useTelemetryStore.getState().setSessionLaps(data.laps);
          } else if (data.type === "dev-state") {
            useTelemetryStore.getState().setDevState(data);
          } else if (data.type === "lap-saved") {
            if (typeof data.sessionId === "number") {
              void handleLapSaved(data.sessionId).catch((error) => console.error("Race-event lap-link recovery failed", error));
            } else {
              void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
            }
          } else if (data.type === "stale-lap-detection") {
            useTelemetryStore.getState().setStaleLapDetection({ sessionCount: data.sessionCount as number, currentVersion: data.currentVersion as string });
          } else if (data.type === "stale-race-results") {
            useTelemetryStore.getState().setStaleRaceResults({ sessionCount: data.sessionCount as number, currentVersion: data.currentVersion as string });
          } else if (data.type === "race-result-reconciled") {
            const store = useTelemetryStore.getState();
            if (typeof data.done === "number" && typeof data.total === "number") {
              const done = data.done;
              const total = data.total;
              const failedNow = data.status === "error";
              const failedEarlier = done > 1 && store.raceResultReprocessError != null;
              if (done === 1) store.setRaceResultReprocessError(null);
              store.setRaceResultReprocessProgress({ done, total });
              if (failedNow) store.setRaceResultReprocessError(RACE_RESULT_REPROCESS_ERROR);
              if (done === total) {
                if (!failedEarlier && !failedNow) store.setStaleRaceResults(null);
                store.setRaceResultReprocessProgress(null);
              }
            }
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
            queryClient.invalidateQueries({ queryKey: queryKeys.sessionResults });
            queryClient.invalidateQueries({ queryKey: queryKeys.raceResultSummaries });
            queryClient.invalidateQueries({ queryKey: queryKeys.raceResultRecents });
          } else if (data.type === "lap-reprocessed" || data.type === "quality-updated") {
            const sessionId = data.sessionId as number;
            for (const queryKey of qualityUpdatedQueryKeys(sessionId)) {
              queryClient.invalidateQueries({ queryKey });
            }
            if (data.type === "lap-reprocessed") {
              useTelemetryStore.getState().incrementReprocessProgress();
            }
          } else if (data.type === "experiment-updated") {
            const sid = data.sessionId as number;
            queryClient.invalidateQueries({ queryKey: ["experiment-tests", sid] });
            queryClient.invalidateQueries({ queryKey: ["experiment", sid] });
          } else if (data.type === "lap-issues") {
            useTelemetryStore.getState().addLapIssues({
              lapId: data.lapId as number,
              lapNumber: data.lapNumber as number,
              issues: data.issues,
              eligibility: data.eligibility,
            });
          } else {
            if (handleWebSocketMessage(data)) packetCountRef.current++;
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        abortVersionRequest();
        const s = useTelemetryStore.getState();
        s.setConnected(false);
        s.setServerStatus(null);
        useDevTelemetryStore.getState().clear();
        // If update was in progress, transition to reconnecting stage
        // Covers both "installing" and "downloading" (race: server may exit before WS "installing" message arrives)
        const stage = s.updateProgress?.stage;
        if (stage === "installing" || stage === "downloading") {
          s.setUpdateProgress({ stage: "reconnecting", percent: 100 });
        }
        wsRef.current = null;
        reconnectTimeoutRef.current = setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    const unsubscribeDev = useDevTelemetryStore.subscribe((state, previous) => {
      if (state.subscriptionWanted === previous.subscriptionWanted) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: state.subscriptionWanted ? "subscribe" : "unsubscribe", channel: "dev-telemetry" }));
      }
    });

    connect();

    const interval = setInterval(() => {
      useTelemetryStore.getState().setPacketsPerSec(packetCountRef.current);
      packetCountRef.current = 0;
    }, 1000);

    return () => {
      unsubscribeDev();
      clearInterval(interval);
      clearTimeout(reconnectTimeoutRef.current);
      abortVersionRequest();
      cancelRaceEventRecoveries();
      useDevTelemetryStore.getState().clear();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // stable — no deps, runs once
}
