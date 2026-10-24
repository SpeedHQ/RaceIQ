import type { LiveTelemetryView } from "../../lib/live-telemetry-view";

export const IRACING_LIVE_FRAME_MAX_AGE_MS = 2_500;

export function selectFreshIRacingLiveView(
  connected: boolean,
  view: LiveTelemetryView | null,
  frameReceivedAtMs: number | null,
  nowMs: number,
): LiveTelemetryView | null {
  if (!connected || view?.simulator !== "iracing" || frameReceivedAtMs === null) return null;
  const ageMs = nowMs - frameReceivedAtMs;
  return Math.abs(ageMs) <= IRACING_LIVE_FRAME_MAX_AGE_MS ? view : null;
}
