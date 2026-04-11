import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";
import { useTelemetryStore } from "../stores/telemetry";
import type { VersionInfo } from "../stores/telemetry";
import { client } from "../lib/rpc";
import { queryClient } from "../lib/queryClient";

function fetchVersionInfo() {
  client.api.version.$get()
    .then((r) => r.json())
    .then((d) => useTelemetryStore.getState().setVersionInfo(d as unknown as VersionInfo))
    .catch(() => {});
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const packetCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    function connect() {
      // Close any existing connection before opening a new one
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect loop
        wsRef.current.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
      wsRef.current = ws;

      // Read store actions via getState() — stable, no dependency issues
      const store = useTelemetryStore.getState();

      ws.onopen = () => {
        // setConnected handles reconnecting → complete transition internally
        store.setConnected(true);
        fetchVersionInfo();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "status") {
            const { type: __ignored, ...status } = data; // eslint-disable-line @typescript-eslint/no-unused-vars
            useTelemetryStore.getState().setServerStatus(status);
          } else if (data.type === "update-available") {
            useTelemetryStore.getState().setUpdateAvailable(data.version as string);
            fetchVersionInfo();
          } else if (data.type === "update-progress") {
            useTelemetryStore.getState().setUpdateProgress({ stage: data.stage, percent: data.percent ?? 0 });
          } else if (data.type === "onboarding_complete") {
            queryClient.invalidateQueries({ queryKey: ["settings"] });
          } else if (data.type === "session-laps") {
            useTelemetryStore.getState().setSessionLaps(data.laps);
          } else if (data.type === "dev-state") {
            useTelemetryStore.getState().setDevState(data);
          } else if (data.type === "lap-saved") {
            // Also trigger a session-laps refresh (server sends it after save)
            queryClient.invalidateQueries({ queryKey: ["laps"] });
          } else {
            const { _sectors, _pit, ...packet } = data;
            const s = useTelemetryStore.getState();
            s.setPacket(packet as TelemetryPacket);
            if (_sectors) s.setSectors(_sectors);
            if (_pit) s.setPit(_pit);
            packetCountRef.current++;
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
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
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on cleanup
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []); // stable — no deps, runs once
}
