import { useEffect, useRef, useCallback, useState } from "react";
import { useTelemetryStore } from "../stores/telemetry";
import { api } from "../lib/api";
import type { TelemetryPacket } from "@shared/types";

/**
 * Demo mode — fetches a real recorded lap from the database and replays
 * its telemetry packets at 60Hz, looping continuously. Picks the best
 * (fastest valid) lap available, preferring Spa (track 530).
 */

export function useDemoMode() {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const setPacket = useTelemetryStore((s) => s.setPacket);
  const clearPacket = useTelemetryStore((s) => s.clearPacket);
  const setConnected = useTelemetryStore((s) => s.setConnected);
  const setPacketsPerSec = useTelemetryStore((s) => s.setPacketsPerSec);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const packetsRef = useRef<TelemetryPacket[]>([]);
  const indexRef = useRef(0);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setActive(false);
    setConnected(false);
    setPacketsPerSec(0);
    clearPacket();
  }, [setConnected, setPacketsPerSec, clearPacket]);

  const startPlayback = useCallback(() => {
    if (timerRef.current) return;
    indexRef.current = 0;
    setActive(true);
    setConnected(true);
    setPacketsPerSec(60);

    timerRef.current = setInterval(() => {
      const packets = packetsRef.current;
      if (packets.length === 0) return;

      // Loop back to start when we reach the end
      if (indexRef.current >= packets.length) {
        indexRef.current = 0;
      }

      setPacket(packets[indexRef.current]);
      indexRef.current++;
    }, 1000 / 60);
  }, [setPacket, setConnected, setPacketsPerSec]);

  const start = useCallback(async () => {
    // If we already have packets cached, just replay
    if (packetsRef.current.length > 0) {
      startPlayback();
      return;
    }

    setLoading(true);
    try {
      const laps = await api.getLaps();
      if (laps.length === 0) {
        setLoading(false);
        return;
      }

      // Prefer Spa (530), then any track — pick fastest valid lap
      const validLaps = laps.filter((l) => l.isValid && l.lapTime > 0);
      const spaLaps = validLaps.filter((l) => l.trackOrdinal === 530);
      const pool = spaLaps.length > 0 ? spaLaps : validLaps;
      const best = pool.sort((a, b) => a.lapTime - b.lapTime)[0];

      if (!best) {
        setLoading(false);
        return;
      }

      const lapData = await api.getLap(best.id);
      if (!lapData?.telemetry || lapData.telemetry.length < 50) {
        setLoading(false);
        return;
      }

      packetsRef.current = lapData.telemetry;
      setLoading(false);
      startPlayback();
    } catch {
      setLoading(false);
    }
  }, [startPlayback]);

  const toggle = useCallback(() => {
    if (active) stop();
    else start();
  }, [active, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  return { active, loading, toggle };
}
