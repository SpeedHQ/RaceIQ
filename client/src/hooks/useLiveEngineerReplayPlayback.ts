import { startTransition, useCallback, useEffect, useMemo, useState } from "react";

import type { LiveEngineerSessionReplayV1 } from "@raceiq/shared/racing/live/engineer-replay-contracts";

export interface ReplayFrameRange {
  startFrameIndex: number;
  endFrameIndex: number;
}

export interface ReplayClockAnchor { wallMs: number; timelineMs: number; speed: number }

export function replayTimeAt(clock: readonly ReplayClockAnchor[], wallMs: number) {
  const anchor = clock.findLast((entry) => entry.wallMs <= wallMs) ?? clock[0]!;
  return anchor.timelineMs + (wallMs - anchor.wallMs) * anchor.speed;
}

export function useLiveEngineerReplayPlayback(replay: LiveEngineerSessionReplayV1 | null, range: ReplayFrameRange | null) {
  const startFrameIndex = Math.max(0, range?.startFrameIndex ?? 0);
  const endFrameIndex = Math.min(Math.max(0, (replay?.frames.length ?? 1) - 1), range?.endFrameIndex ?? Math.max(0, (replay?.frames.length ?? 1) - 1));
  const [clock, setClock] = useState<readonly ReplayClockAnchor[]>([]);
  const playing = clock.length > 0;
  const [cursorIdx, setCursorIdx] = useState(startFrameIndex);
  const [speed, setPlaybackSpeed] = useState(1);
  const frame = replay?.frames[cursorIdx] ?? null;

  useEffect(() => {
    setClock([]);
    setCursorIdx(startFrameIndex);
  }, [replay, startFrameIndex, endFrameIndex]);

  useEffect(() => {
    if (!playing || !replay) return;
    let request: number;
    let index = startFrameIndex;
    const tick = () => {
      const time = replayTimeAt(clock, performance.now());
      while (index < endFrameIndex && replay.frames[index + 1]!.timelineMs <= time) index++;
      startTransition(() => setCursorIdx(index));
      if (index === endFrameIndex) setClock([]);
      else request = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(request);
  }, [clock, playing, replay, startFrameIndex, endFrameIndex]);

  const seek = useCallback((index: number) => {
    setClock([]);
    setCursorIdx(Math.max(startFrameIndex, Math.min(index, endFrameIndex)));
  }, [startFrameIndex, endFrameIndex]);

  const step = useCallback((delta: number) => {
    setClock([]);
    setCursorIdx((index) => Math.max(startFrameIndex, Math.min(index + delta, endFrameIndex)));
  }, [startFrameIndex, endFrameIndex]);

  const play = useCallback(() => {
    const index = cursorIdx >= endFrameIndex ? startFrameIndex : cursorIdx;
    setCursorIdx(index);
    setClock([{ wallMs: performance.now(), timelineMs: replay?.frames[index]?.timelineMs ?? 0, speed }]);
  }, [cursorIdx, startFrameIndex, endFrameIndex, replay, speed]);

  const pause = useCallback(() => setClock([]), []);
  const setSpeed = useCallback((next: number) => {
    const wallMs = performance.now();
    setClock((current) => current.length ? [...current, { wallMs, timelineMs: replayTimeAt(current, wallMs), speed: next }] : current);
    setPlaybackSpeed(next);
  }, []);

  return useMemo(() => ({
    clock,
    playing,
    play,
    pause,
    cursorIdx,
    frame,
    speed,
    setSpeed,
    seek,
    step,
    startFrameIndex,
    endFrameIndex,
  }), [clock, playing, play, pause, cursorIdx, frame, speed, setSpeed, seek, step, startFrameIndex, endFrameIndex]);
}
