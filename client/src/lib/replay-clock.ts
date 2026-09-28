import type { SemanticReplayFrame } from "../hooks/laps";
import { semanticNumber, type SemanticAnalysisFrame } from "../components/analyse/track-map/types";

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

/** Gap markers describe missing acquisition data, not elapsed playback time. */
export function replayGapSeconds(previous: SemanticAnalysisFrame, current: SemanticAnalysisFrame): number {
  const before = previous.recordedLapTime ?? semanticNumber(previous, "timing.current-lap") ?? 0;
  const after = current.recordedLapTime ?? semanticNumber(current, "timing.current-lap") ?? 0;
  const captureGap = previous.captureTimeMs !== undefined && current.captureTimeMs !== undefined
    ? (current.captureTimeMs - previous.captureTimeMs) / 1000 : 0;
  return Math.max(after - before, captureGap);
}
