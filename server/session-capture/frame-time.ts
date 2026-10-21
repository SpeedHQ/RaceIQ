import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

/** Attach recorder UTC separately from simulator time; Kunos has no source UTC clock. */
export function applyFrameTime(packet: Pick<TelemetryPacket, "gameId" | "TimestampMS" | "extendedRaceIQ">, frameTimeMs?: number): void {
  if (frameTimeMs === undefined) return;
  (packet.extendedRaceIQ ??= {}).frameTimeMs = frameTimeMs;
  if (packet.gameId === "acc" || packet.gameId === "ac-evo") packet.TimestampMS = frameTimeMs;
}

/**
 * Native acquisition records Date.now() separately from simulator clocks:
 * UDP ingress, TripletAssembler, IRacingTelemetrySource and LMUTelemetrySource.
 * Legacy/imported rows are unknown unless portable metadata retained this contract.
 */
export function recordedCaptureFrameClock(session: {
  nativeCaptureOrigin: boolean; captureFormatVersion: number | null; captureFrameClock: "capture_utc" | "unknown" | null;
}): "capture_utc" | "unknown" {
  return session.captureFrameClock === "capture_utc" || (session.nativeCaptureOrigin && session.captureFormatVersion === 1)
    ? "capture_utc" : "unknown";
}

export function recordedCaptureClockAnchor(value: unknown): { frameTimeMs: number; utcTimeMs: number } | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const pair = parsed as Record<string, unknown>;
  if (typeof pair.frameTimeMs !== "number" || !Number.isSafeInteger(pair.frameTimeMs) || pair.frameTimeMs < 0
    || typeof pair.utcTimeMs !== "number" || !Number.isSafeInteger(pair.utcTimeMs) || pair.utcTimeMs < 0
    || pair.utcTimeMs > 8_640_000_000_000_000) return null;
  return { frameTimeMs: pair.frameTimeMs, utcTimeMs: pair.utcTimeMs };
}
