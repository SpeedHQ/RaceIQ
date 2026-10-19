import { useCallback, useEffect } from "react";
import type { ChartsPanelHandle } from "../components/analyse/AnalyseChartsPanel";
import { type SemanticAnalysisFrame, semanticNumber, type TrackMapHandle } from "../components/analyse/track-map/types";

// React-owned gauges publish at display cadence while canvas animation stays smooth.
export const REACT_STATE_INTERVAL_MS = 1000 / 60;

export function interpolateReplayCursorIndex(
  lowerIndex: number,
  lowerTime: number,
  upperTime: number,
  targetTime: number,
): number {
  if (
    !Number.isFinite(lowerIndex) ||
    !Number.isFinite(lowerTime) ||
    !Number.isFinite(upperTime) ||
    !Number.isFinite(targetTime) ||
    upperTime <= lowerTime
  ) {
    return lowerIndex;
  }
  return lowerIndex + Math.max(0, Math.min(1, (targetTime - lowerTime) / (upperTime - lowerTime)));
}

interface UseLapPlaybackOptions {
  playing: boolean;
  smoothCursor: boolean;
  playRef: React.MutableRefObject<boolean>;
  telemetry: SemanticAnalysisFrame[];
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
  smoothCursor,
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
  const updateOverlays = useCallback(
    (idx: number) => {
      trackMapRef.current?.updateCursor(idx);
      chartsPanelRef.current?.updateCursor(idx);
      const timeFracs = chartsPanelRef.current?.timeFracs;
      const maxIndex = Math.max(0, telemetry.length - 1);
      const index = Math.max(0, Math.min(maxIndex, idx));
      const lowerIndex = Math.floor(index);
      const upperIndex = Math.min(maxIndex, lowerIndex + 1);
      const fraction = index - lowerIndex;
      const lowerFrac = timeFracs?.[lowerIndex] ?? lowerIndex / Math.max(1, maxIndex);
      const upperFrac = timeFracs?.[upperIndex] ?? upperIndex / Math.max(1, maxIndex);
      const pct = `${(lowerFrac + (upperFrac - lowerFrac) * fraction) * 100}%`;
      if (thumbRef.current) thumbRef.current.style.left = pct;
      if (progressRef.current) progressRef.current.style.width = pct;
    },
    [telemetry.length, trackMapRef, chartsPanelRef, thumbRef, progressRef],
  );

  // Play/pause animation — uses CurrentLap timer for accurate real-time playback
  useEffect(() => {
    playRef.current = playing;
    if (!playing || telemetry.length < 2) return;

    let rafId: number;
    let wallStart = performance.now();
    let gameStart = semanticNumber(telemetry[cursorRef.current], "timing.current-lap") ?? 0;
    let lastSpeedChange = speedChangeRef.current;
    let lastSeek = seekRef.current;
    function step(now: number) {
      if (!playRef.current) return;
      const idx = cursorRef.current;
      if (idx >= telemetry.length - 1) {
        const lastIdx = telemetry.length - 1;
        cursorRef.current = lastIdx;
        updateOverlays(lastIdx);
        setCursorIdx(lastIdx);
        interpolatedTimeRef.current = semanticNumber(telemetry[lastIdx], "timing.current-lap") ?? 0;
        playRef.current = false;
        setPlaying(() => false);
        return;
      }

      if (seekRef.current !== lastSeek) {
        lastSeek = seekRef.current;
        wallStart = now;
        gameStart = semanticNumber(telemetry[idx], "timing.current-lap") ?? 0;
      }
      if (speedChangeRef.current !== lastSpeedChange) {
        lastSpeedChange = speedChangeRef.current;
        wallStart = now;
        gameStart = semanticNumber(telemetry[idx], "timing.current-lap") ?? 0;
      }

      let nextIdx = idx;
      const wallElapsed = (now - wallStart) / 1000;
      const gameTarget = gameStart + wallElapsed * speedRef.current;
      interpolatedTimeRef.current = gameTarget;
      while (nextIdx < telemetry.length - 1 && (semanticNumber(telemetry[nextIdx + 1], "timing.current-lap") ?? 0) <= gameTarget) {
        nextIdx++;
      }

      if (smoothCursor) {
        const lowerTime = semanticNumber(telemetry[nextIdx], "timing.current-lap") ?? gameTarget;
        const upperTime = semanticNumber(telemetry[nextIdx + 1], "timing.current-lap") ?? lowerTime;
        updateOverlays(interpolateReplayCursorIndex(nextIdx, lowerTime, upperTime, gameTarget));
      }

      if (nextIdx !== idx) {
        cursorRef.current = nextIdx;
        if (!smoothCursor) updateOverlays(nextIdx);
        if (now - lastStateUpdateRef.current > REACT_STATE_INTERVAL_MS) {
          lastStateUpdateRef.current = now;
          setCursorIdx(nextIdx);
        }
      }

      rafId = requestAnimationFrame(step);
    }
    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
  }, [playing, telemetry, updateOverlays, smoothCursor]);

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
