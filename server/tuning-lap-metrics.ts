import type { TelemetryPacket } from "../shared/types";

/**
 * Per-lap tuning metrics derived server-side from a lap's raw telemetry frames
 * (plan §2 "Per-lap metrics"). Fields are optional: a metric is omitted entirely
 * when the underlying channel is unavailable, so the UI shows "—" rather than a
 * fabricated 0.
 */
export interface LapMetric {
  lapId: number;
  /** Litres consumed over the lap. */
  fuelPerLap?: number;
  /**
   * Tyre wear per lap. Currently always omitted: ACC and AC-Evo shared memory
   * expose tyre temps/pressures but no genuine wear channel, so there is nothing
   * real to derive. Kept in the shape so a future game/channel can populate it.
   */
  tyreWear?: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Fuel used over a lap, in litres. Prefers the parser-provided per-lap fuel field
 * (ACC & AC-Evo both populate `acc.fuelPerLap`, litres) — the game's own rolling
 * estimate, read from the last frame that reports a positive value (most complete
 * at lap end). Falls back to the Δ of remaining fuel across the lap's frames
 * (first − last; `Fuel` is litres-remaining for ACC/AC-Evo).
 *
 * Returns undefined when neither source is usable — including legacy laps with no
 * stored telemetry — so the caller omits the metric instead of reporting 0.
 */
export function deriveFuelPerLap(packets: TelemetryPacket[]): number | undefined {
  if (packets.length < 2) return undefined;

  // Prefer the game-computed per-lap fuel field, latest positive reading.
  for (let i = packets.length - 1; i >= 0; i--) {
    const f = packets[i].acc?.fuelPerLap;
    if (typeof f === "number" && Number.isFinite(f) && f > 0) return round2(f);
  }

  // Fallback: fuel burned = remaining at lap start − remaining at lap end.
  const first = packets[0].Fuel;
  const last = packets[packets.length - 1].Fuel;
  if (typeof first === "number" && typeof last === "number") {
    const delta = first - last;
    // Guard against noise/refuels: a real GT lap burns a few litres, never
    // negative and never a full tank.
    if (delta > 0 && delta < 100) return round2(delta);
  }

  return undefined;
}
