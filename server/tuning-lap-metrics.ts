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
   * Worst-tyre wear at lap end, as a percentage worn (0 = new, 100 = dead).
   * Derived from the game's per-tyre wear channel (ACC/AC-Evo shared memory and
   * F1 both expose it); omitted when no frame carries a usable reading.
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

/**
 * Worst-tyre wear at lap end, as a percentage worn (0 = new, 100 = fully worn).
 *
 * `TireWearFL/FR/RL/RR` are a 0..1 fraction worn (higher = more worn) on ACC and
 * AC-Evo, and on F1 (which divides its raw 0..100 channel by 100). F1 also sets
 * them to -1 when the channel is unavailable, so negatives are skipped. Reads the
 * last frame whose four tyres are all finite and ≥ 0 (most worn, and complete at
 * lap end), then reports the single worst tyre × 100.
 *
 * Returns undefined when no frame carries a usable reading — legacy laps with no
 * stored telemetry, or games without a wear channel — so the caller omits the
 * metric instead of reporting 0.
 */
export function deriveTyreWear(packets: TelemetryPacket[]): number | undefined {
  for (let i = packets.length - 1; i >= 0; i--) {
    const p = packets[i];
    const tyres = [p.TireWearFL, p.TireWearFR, p.TireWearRL, p.TireWearRR];
    if (tyres.some((w) => typeof w !== "number" || !Number.isFinite(w) || w < 0)) continue;
    const worst = Math.max(...(tyres as number[]));
    return round2(worst * 100);
  }
  return undefined;
}
