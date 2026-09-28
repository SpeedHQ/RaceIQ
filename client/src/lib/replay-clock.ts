import type { SemanticReplayFrame } from "../hooks/laps";

/** Recorder UTC identifies missing capture time; only simulator lap time drives replay. */
export function replayLapTimes(frames: readonly SemanticReplayFrame[]): number[] {
  const times = new Array<number>(frames.length);
  let removed = 0;
  let previousTime = 0;
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    const native = frame.values.find((value) => value.semanticId === "timing.current-lap")?.value;
    const time = typeof native === "number" ? native : 0;
    if (index > 0) {
      const previous = frames[index - 1]!;
      const elapsed = time - previousTime;
      if (frame.captureTimeMs !== undefined && previous.captureTimeMs !== undefined &&
          frame.captureTimeMs - previous.captureTimeMs > 100 && elapsed > 0.1) {
        // No frames exist during a recorder pause. Keep at most one frame interval.
        removed += elapsed - 0.1;
      }
    }
    previousTime = time;
    times[index] = time - removed;
  }
  return times;
}
