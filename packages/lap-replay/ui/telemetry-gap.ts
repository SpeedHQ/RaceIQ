const TELEMETRY_GAP_SECONDS = 0.1;
const TELEMETRY_GAP_TOLERANCE_SECONDS = 0.001;

export function hasTelemetryGap(previousTime: number, currentTime: number): boolean {
  return currentTime - previousTime > TELEMETRY_GAP_SECONDS + TELEMETRY_GAP_TOLERANCE_SECONDS;
}
