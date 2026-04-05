import { useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";
import { useTelemetryStore } from "../stores/telemetry";

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

      ws.onopen = () => store.setConnected(true);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "status") {
            const { type: _, ...status } = data;
            useTelemetryStore.getState().setServerStatus(status);
          } else if (data.type === "update-available") {
            useTelemetryStore.getState().setUpdateAvailable(data.version as string);
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
