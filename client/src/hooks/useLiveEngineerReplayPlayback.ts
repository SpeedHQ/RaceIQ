import { useCallback, useEffect, useMemo, useState } from "react";

import type { LiveEngineerSessionReplayV1 } from "@shared/racing/live/engineer-replay-contracts";

export interface ReplayFrameRange {
  startFrameIndex: number;
  endFrameIndex: number;
}

export function useLiveEngineerReplayPlayback(replay: LiveEngineerSessionReplayV1 | null, range: ReplayFrameRange | null) {
  const startFrameIndex = Math.max(0, range?.startFrameIndex ?? 0);
  const endFrameIndex = Math.min(Math.max(0, (replay?.frames.length ?? 1) - 1), range?.endFrameIndex ?? Math.max(0, (replay?.frames.length ?? 1) - 1));
  const [playing, setPlaying] = useState(false);
  const [cursorIdx, setCursorIdx] = useState(startFrameIndex);
  const [speed, setSpeed] = useState(1);
  const frame = replay?.frames[cursorIdx] ?? null;

  useEffect(() => {
    setPlaying(false);
    setCursorIdx(startFrameIndex);
  }, [replay, startFrameIndex, endFrameIndex]);

  useEffect(() => {
    if (!playing || !replay || cursorIdx >= endFrameIndex) {
      if (playing && cursorIdx >= endFrameIndex) setPlaying(false);
      return;
    }
    const currentTime = frame?.timelineMs ?? 0;
    const nextIndex = Math.min(cursorIdx + 1, endFrameIndex);
    const nextTime = replay.frames[nextIndex]?.timelineMs ?? currentTime;
    const timer = window.setTimeout(() => setCursorIdx(nextIndex), Math.max(1, (nextTime - currentTime) / speed));
    return () => window.clearTimeout(timer);
  }, [playing, replay, cursorIdx, endFrameIndex, speed, frame]);

  const seek = useCallback((index: number) => {
    setPlaying(false);
    setCursorIdx(Math.max(startFrameIndex, Math.min(index, endFrameIndex)));
  }, [startFrameIndex, endFrameIndex]);

  const step = useCallback((delta: number) => {
    setPlaying(false);
    setCursorIdx((index) => Math.max(startFrameIndex, Math.min(index + delta, endFrameIndex)));
  }, [startFrameIndex, endFrameIndex]);

  const play = useCallback(() => {
    setCursorIdx((index) => index >= endFrameIndex ? startFrameIndex : index);
    setPlaying(true);
  }, [startFrameIndex, endFrameIndex]);

  const pause = useCallback(() => setPlaying(false), []);

  return useMemo(() => ({
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
  }), [playing, play, pause, cursorIdx, frame, speed, seek, step, startFrameIndex, endFrameIndex]);
}
