import { useEffect, useRef } from "react";
import { queryClient } from "../lib/queryClient";
import { client } from "../lib/rpc";
import { handleWebSocketMessage } from "../lib/websocket-messages";
import { isLiveEngineerCalloutMessageV2, isLiveEngineerVoiceLineMessageV2 } from "../../../shared/racing/live/engineer-contracts";
import { useTelemetryStore, type ServerStatus, type VersionInfo } from "../stores/telemetry";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { TuneIssue } from "../../../shared/racing/tuning/issues";
import { useDevTelemetryStore } from "../stores/dev-telemetry";
import { useLiveEngineerStore } from "../stores/live-engineer";
import { queryKeys } from "./query-keys";
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

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const packetCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const versionRequestControllerRef = useRef<AbortController | null>(null);
  const versionRequestTimeoutRef = useRef<number | undefined>(undefined);

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
        if (useDevTelemetryStore.getState().subscriptionWanted) {
          ws.send(JSON.stringify({ type: "subscribe", channel: "dev-telemetry" }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as Record<string, unknown>;
          const liveStore = useLiveEngineerStore.getState();
          if (isLiveEngineerCalloutMessageV2(data)) liveStore.receiveCallout(data);
          else if (isLiveEngineerVoiceLineMessageV2(data)) liveStore.receiveVoiceLine(data);
          else if (data.type === "status") useTelemetryStore.getState().setServerStatus(data as unknown as ServerStatus);
          else if (data.type === "update-available") { useTelemetryStore.getState().setUpdateAvailable(data.version as string); startVersionRequest(); }
          else if (data.type === "update-progress") useTelemetryStore.getState().setUpdateProgress({ stage: data.stage as "complete" | "downloading" | "installing" | "reconnecting", percent: Number(data.percent ?? 0) });
          else if (data.type === "onboarding_complete") queryClient.invalidateQueries({ queryKey: ["settings"] });
          else if (data.type === "session-laps") useTelemetryStore.getState().setSessionLaps(data.laps as LapMeta[]);
          else if (data.type === "dev-state") useTelemetryStore.getState().setDevState(data);
          else if (data.type === "lap-saved") queryClient.invalidateQueries({ queryKey: ["laps"] });
          else if (data.type === "stale-lap-detection") {
            useTelemetryStore.getState().setStaleLapDetection({ sessionCount: data.sessionCount as number, currentVersion: data.currentVersion as string });
          }
          else if (data.type === "stale-race-results") {
            useTelemetryStore.getState().setStaleRaceResults({ sessionCount: data.sessionCount as number, currentVersion: data.currentVersion as string });
          }
          else if (data.type === "race-result-reconciled") {
            const store = useTelemetryStore.getState();
            const done = data.done as number;
            const total = data.total as number;
            const failedNow = data.status === "error";
            const failedEarlier = done > 1 && store.raceResultReprocessError != null;
            if (done === 1) store.setRaceResultReprocessError(null);
            store.setRaceResultReprocessProgress({ done, total });
            if (failedNow) store.setRaceResultReprocessError(RACE_RESULT_REPROCESS_ERROR);
            if (done === total) {
              if (!failedEarlier && !failedNow) store.setStaleRaceResults(null);
              store.setRaceResultReprocessProgress(null);
            }
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
            queryClient.invalidateQueries({ queryKey: queryKeys.sessionResults });
            queryClient.invalidateQueries({ queryKey: queryKeys.raceResultSummaries });
            queryClient.invalidateQueries({ queryKey: queryKeys.raceResultRecents });
          } else if (data.type === "lap-reprocessed") {
            queryClient.invalidateQueries({ queryKey: ["laps"] });
            queryClient.invalidateQueries({ queryKey: ["sessions"] });
            useTelemetryStore.getState().incrementReprocessProgress();
          } else if (data.type === "experiment-updated") {
            const sid = data.sessionId as number;
            queryClient.invalidateQueries({ queryKey: ["experiment-tests", sid] });
            queryClient.invalidateQueries({ queryKey: ["experiment", sid] });
          } else if (data.type === "lap-issues") {
            useTelemetryStore.getState().addLapIssues({
              lapId: data.lapId as number,
              lapNumber: data.lapNumber as number,
              issues: data.issues as TuneIssue[],
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
    const unsubscribeLiveEngineer = useLiveEngineerStore.subscribe((state, previous) => {
      if (state.outbound.length === previous.outbound.length) return;
      const ws = wsRef.current;
      const message = state.outbound[state.outbound.length - 1];
      if (ws?.readyState === WebSocket.OPEN && message) ws.send(JSON.stringify(message));
      if (message) useLiveEngineerStore.getState().takeOutbound();
    });


    connect();

    const interval = setInterval(() => {
      useTelemetryStore.getState().setPacketsPerSec(packetCountRef.current);
      packetCountRef.current = 0;
    }, 1000);

    return () => {
      unsubscribeDev();
      unsubscribeLiveEngineer();
      clearInterval(interval);
      clearTimeout(reconnectTimeoutRef.current);
      abortVersionRequest();
      useDevTelemetryStore.getState().clear();
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // stable — no deps, runs once
}
