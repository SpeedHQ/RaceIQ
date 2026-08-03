import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { queryClient } from "../lib/queryClient";
import { client } from "../lib/rpc";
import type { VersionInfo } from "../stores/telemetry";
import { useTelemetryStore } from "../stores/telemetry";
import { buildWebSocketUrl, type DevWebSocketTarget } from "./websocket-url";

declare const __RACEIQ_DEV_WS_TARGET__: DevWebSocketTarget;

const VERSION_REQUEST_TIMEOUT_MS = 10_000;

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
        // setConnected handles reconnecting → complete transition internally
        store.setConnected(true);
        startVersionRequest();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "status") {
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
            queryClient.invalidateQueries({ queryKey: ["laps"] });
          } else if (data.type === "stale-lap-detection") {
            useTelemetryStore.getState().setStaleLapDetection({ sessionCount: data.sessionCount as number, currentVersion: data.currentVersion as string });
          } else if (data.type === "stale-race-results") {
            useTelemetryStore.getState().setStaleRaceResults({ sessionCount: data.sessionCount as number, currentVersion: data.currentVersion as string });
          } else if (data.type === "race-result-reconciled") {
            const store = useTelemetryStore.getState();
            store.setRaceResultReprocessProgress({ done: data.done as number, total: data.total as number });
            if (data.done === data.total && data.status !== "error") {
              store.setStaleRaceResults(null);
            }
            queryClient.invalidateQueries({ queryKey: ["sessions"] });
            queryClient.invalidateQueries({ queryKey: ["race-results"] });
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
              issues: data.issues,
            });
          } else {
            const { _sectors, _pit, _liveIssues, ...packet } = data;
            const s = useTelemetryStore.getState();
            s.setPacket(packet as TelemetryPacket);
            if (_sectors) s.setSectors(_sectors);
            if (_pit) s.setPit(_pit);
            if (_liveIssues) s.setLiveIssues(_liveIssues);
            packetCountRef.current++;
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

    connect();

    const interval = setInterval(() => {
      useTelemetryStore.getState().setPacketsPerSec(packetCountRef.current);
      packetCountRef.current = 0;
    }, 1000);

    return () => {
      clearInterval(interval);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      abortVersionRequest();
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // stable — no deps, runs once
}
