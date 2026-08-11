import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../../shared/telemetry/live/contracts";
import { client } from "../lib/rpc";
import { useTelemetryStore } from "../stores/telemetry";

type DemoLap = { id: number; gameId: string; trackOrdinal?: number; isValid?: boolean; lapTime?: number };
type ReplayResponse = { schema?: LiveTelemetrySchemaMessageV1; frames?: LiveTelemetryFrameMessageV1[] };

export function useDemoMode(preferGameId?: string) {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const setSchema = useTelemetryStore((s) => s.setTelemetrySchema);
  const setFrame = useTelemetryStore((s) => s.setTelemetryFrame);
  const clearTelemetry = useTelemetryStore((s) => s.clearTelemetry);
  const setConnected = useTelemetryStore((s) => s.setConnected);
  const setPacketsPerSec = useTelemetryStore((s) => s.setPacketsPerSec);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const framesRef = useRef<LiveTelemetryFrameMessageV1[]>([]);
  const indexRef = useRef(0);

  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setActive(false); setConnected(false); setPacketsPerSec(0); clearTelemetry();
  }, [setConnected, setPacketsPerSec, clearTelemetry]);

  const startPlayback = useCallback(() => {
    if (timerRef.current) return;
    indexRef.current = 0; setActive(true); setConnected(true); setPacketsPerSec(60);
    timerRef.current = setInterval(() => {
      const frames = framesRef.current;
      if (!frames.length) return;
      if (indexRef.current >= frames.length) indexRef.current = 0;
      setFrame(frames[indexRef.current]!); indexRef.current++;
    }, 1000 / 60);
  }, [setFrame, setConnected, setPacketsPerSec]);

  const start = useCallback(async () => {
    if (framesRef.current.length) { startPlayback(); return; }
    setLoading(true);
    try {
      const response = await client.api.laps.$get({ query: {} });
      const laps = (await response.json()) as DemoLap[];
      const valid = laps.filter((lap) => lap.isValid && (lap.lapTime ?? 0) > 0);
      const preferred = preferGameId ? valid.filter((lap) => lap.gameId === preferGameId) : [];
      const spa = valid.filter((lap) => lap.trackOrdinal === 530);
      const pool = preferred.length ? preferred : spa.length ? spa : valid;
      const best = [...pool].sort((a, b) => (a.lapTime ?? Infinity) - (b.lapTime ?? Infinity))[0];
      if (!best) return;
      const replaySemanticIds = ["motion.speed", "timing.lap-number", "timing.current-lap", "engine.current-engine-rpm", "inputs.gear", "tire.temperature.average", "tires.tire-wear", "tires.tire-pressure"].join(",");
      const replayResponse = await fetch(`/api/dev/laps/${best.id}/live-telemetry?semanticIds=${encodeURIComponent(replaySemanticIds)}`);
      const replay = (await replayResponse.json()) as ReplayResponse;
      if (!replay.schema || !replay.frames || replay.frames.length < 2) return;
      setSchema(replay.schema); framesRef.current = replay.frames; startPlayback();
    } finally { setLoading(false); }
  }, [preferGameId, setSchema, startPlayback]);

  const toggle = useCallback(() => { if (active) stop(); else void start(); }, [active, start, stop]);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
  return { active, loading, toggle };
}
