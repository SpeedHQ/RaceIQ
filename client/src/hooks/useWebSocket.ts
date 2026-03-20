import { useEffect, useRef, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import { useTelemetryStore } from "../stores/telemetry";

export function useWebSocket() {
  const { setConnected, setPacket, setPacketsPerSec } = useTelemetryStore();
  const wsRef = useRef<WebSocket | null>(null);
  const packetCountRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as TelemetryPacket;
        setPacket(data);
        packetCountRef.current++;
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimeoutRef.current = setTimeout(connect, 1000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [setConnected, setPacket]);

  useEffect(() => {
    connect();

    const interval = setInterval(() => {
      setPacketsPerSec(packetCountRef.current);
      packetCountRef.current = 0;
    }, 1000);

    return () => {
      clearInterval(interval);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect, setPacketsPerSec]);
}
