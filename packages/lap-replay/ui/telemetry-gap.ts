const TELEMETRY_GAP_SECONDS = 0.1;
const TELEMETRY_GAP_TOLERANCE_SECONDS = 0.001;

export function hasTelemetryGap(previousTime: number, currentTime: number, maximumGapSeconds = TELEMETRY_GAP_SECONDS): boolean {
  return currentTime - previousTime > maximumGapSeconds + TELEMETRY_GAP_TOLERANCE_SECONDS;
}

/** Permit normal sampling jitter in reduced AMS2 recordings, without bridging missing ticks. */
export function recordedTelemetryGapSeconds(timestamps: readonly number[]): number {
  const intervals: number[] = [];
  for (let index = 1; index < timestamps.length; index++) {
    const interval = (timestamps[index]! - timestamps[index - 1]!) / 1000;
    if (Number.isFinite(interval) && interval > 0) intervals.push(interval);
  }
  if (intervals.length < 3) return TELEMETRY_GAP_SECONDS;
  intervals.sort((a, b) => a - b);
  // The lower quartile resists isolated dropouts and includes retained transition frames.
  const cadence = intervals[Math.floor((intervals.length - 1) / 4)]!;
  return Math.max(TELEMETRY_GAP_SECONDS, Math.min(0.25, cadence * 1.5));
}
