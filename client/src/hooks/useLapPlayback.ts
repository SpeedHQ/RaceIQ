import { useEffect, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";
import type { TrackMapHandle } from "../components/analyse/AnalyseTrackMap";
import type { ChartsPanelHandle } from "../components/analyse/AnalyseChartsPanel";

interface UseLapPlaybackOptions {
  playing: boolean;
  telemetry: TelemetryPacket[];
  playRef: React.MutableRefObject<boolean>;
  speedRef: React.MutableRefObject<number>;
  cursorRef: React.MutableRefObject<number>;
  seekRef: React.MutableRefObject<number>;
  speedChangeRef: React.MutableRefObject<number>;
  lastStateUpdateRef: React.MutableRefObject<number>;
  interpolatedTimeRef: React.MutableRefObject<number>;
  trackMapRef: React.RefObject<TrackMapHandle | null>;
  chartsPanelRef: React.RefObject<ChartsPanelHandle | null>;
  thumbRef: React.RefObject<HTMLDivElement | null>;
  progressRef: React.RefObject<HTMLDivElement | null>;
  setCursorIdx: (idx: number) => void;
  setPlaying: (updater: (p: boolean) => boolean) => void;
}

export function useLapPlayback({
  playing,
  telemetry,
  playRef,
  speedRef,
  cursorRef,
  seekRef,
  speedChangeRef,
  lastStateUpdateRef,
  interpolatedTimeRef,
  trackMapRef,
  chartsPanelRef,
  thumbRef,
  progressRef,
  setCursorIdx,
  setPlaying,
}: UseLapPlaybackOptions) {
  const updateOverlays = useCallback((idx: number) => {
    trackMapRef.current?.updateCursor(idx);
    chartsPanelRef.current?.updateCursor(idx);
    const tf = chartsPanelRef.current?.timeFracs;
    const pct = tf ? `${(tf[idx] ?? 0) * 100}%` : `${(idx / Math.max(1, (telemetry.length - 1))) * 100}%`;
    if (thumbRef.current) thumbRef.current.style.left = pct;
    if (progressRef.current) progressRef.current.style.width = pct;
  }, [telemetry.length, trackMapRef, chartsPanelRef, thumbRef, progressRef]);

  // Play/pause animation — uses CurrentLap timer for accurate real-time playback
  useEffect(() => {
    playRef.current = playing;
    if (!playing || telemetry.length < 2) return;

    let rafId: number;
    let wallStart = performance.now();
    let gameStart = telemetry[cursorRef.current].CurrentLap;
    let lastSpeedChange = speedChangeRef.current;
    let lastSeek = seekRef.current;

    function step(now: number) {
      if (!playRef.current) return;
      const idx = cursorRef.current;
      if (idx >= telemetry.length - 1) {
        cursorRef.current = 0;
        updateOverlays(0);
        setCursorIdx(0);
        lastStateUpdateRef.current = now;
        wallStart = now;
        gameStart = telemetry[0].CurrentLap;
        lastSeek = seekRef.current;
        rafId = requestAnimationFrame(step);
        return;
      }

      if (seekRef.current !== lastSeek) {
        lastSeek = seekRef.current;
        wallStart = now;
        gameStart = telemetry[idx].CurrentLap;
      }
      if (speedChangeRef.current !== lastSpeedChange) {
        lastSpeedChange = speedChangeRef.current;
        wallStart = now;
        gameStart = telemetry[idx].CurrentLap;
      }

      const wallElapsed = (now - wallStart) / 1000;
      const gameTarget = gameStart + wallElapsed * speedRef.current;
      interpolatedTimeRef.current = gameTarget;

      let nextIdx = idx;
      while (nextIdx < telemetry.length - 1 && telemetry[nextIdx + 1].CurrentLap <= gameTarget) {
        nextIdx++;
      }

      if (nextIdx !== idx) {
        cursorRef.current = nextIdx;
        updateOverlays(nextIdx);
        if (now - lastStateUpdateRef.current > 33) {
          lastStateUpdateRef.current = now;
          setCursorIdx(nextIdx);
        }
      }

      rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
  }, [playing, telemetry, updateOverlays]);

  // Keyboard controls
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (telemetry.length === 0) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const next = Math.max(0, cursorRef.current - 1);
        cursorRef.current = next;
        setCursorIdx(next);
        updateOverlays(next);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = Math.min(telemetry.length - 1, cursorRef.current + 1);
        cursorRef.current = next;
        setCursorIdx(next);
        updateOverlays(next);
      } else if (e.key === " ") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setPlaying((p) => !p);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [telemetry, cursorRef, setCursorIdx, setPlaying, updateOverlays]);

  return { updateOverlays };
}
