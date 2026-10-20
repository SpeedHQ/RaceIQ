/**
 * telemetryToTrackConditions — deterministic weather / track-surface summary
 * from a lap's telemetry.
 *
 * Shared by the Setup Engineer's `get_track_conditions` tool and the Lap
 * Analyst prompt: both need to know whether a slow lap is a *weather* problem
 * (cold/green/wet track) versus a driver or setup one, and both must read the
 * same fields the same way.
 *
 * Game-agnostic. The condition channels live in different places per game:
 *   - ACC / AC-EVO — on `packet.acc` (rain/grip/wind + air/road temp), with
 *     AC-EVO's static session grip on `packet.acc.acEvo`.
 *   - F1 — top-level `AirTemp` / `TrackTemp` / `RainPercent` (0-100), mirrored
 *     on `packet.f1`.
 *   - Forza — no weather channel; the extractor returns null.
 *
 * Returns null when no game in the stint exposes any condition data, so callers
 * simply omit the section.
 */
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

export interface TrackConditions {
  frames: number;
  /** Air / road surface temperature (°C) across the lap. null when unrecorded. */
  airTempC: { min: number; max: number; avg: number } | null;
  roadTempC: { min: number; max: number; avg: number } | null;
  /** Mean rain fraction 0..1; `wet` when the mean crosses a light-rain floor. */
  rainIntensity: number;
  wet: boolean;
  /** Most-common non-empty grip descriptor across frames ("optimum"/"green"/…). */
  trackGripStatus: string;
  windSpeedKmh: number;
  windDirectionDeg: number;
  /** AC-EVO only: static session grip label + whether weather is fixed. */
  startingGrip: string | null;
  staticWeather: boolean | null;
}

/** Mean rain fraction above which the lap is treated as wet. */
const WET_RAIN_FRACTION = 0.02;

function firstFinite(a: number | null | undefined, b: number | null | undefined, c: number | null | undefined, d: number | null | undefined): number | null {
  if (a != null && Number.isFinite(a)) return a;
  if (b != null && Number.isFinite(b)) return b;
  if (c != null && Number.isFinite(c)) return c;
  if (d != null && Number.isFinite(d)) return d;
  return null;
}

type NumericRange = { min: number; max: number; sum: number; count: number };

/** Bounded-memory reduction for one-pass capture processing. */
export class TrackConditionsAccumulator {
  private frames = 0;
  private anyData = false;
  private air: NumericRange | null = null;
  private road: NumericRange | null = null;
  private rainSum = 0;
  private rainCount = 0;
  private windSum = 0;
  private windCount = 0;
  private windDirectionSum = 0;
  private windDirectionCount = 0;
  private readonly gripCounts = new Map<string, number>();
  private startingGrip: string | null = null;
  private staticWeather: boolean | null = null;

  private addRange(current: NumericRange | null, value: number): NumericRange {
    if (current) {
      current.min = Math.min(current.min, value);
      current.max = Math.max(current.max, value);
      current.sum += value;
      current.count++;
      return current;
    }
    return { min: value, max: value, sum: value, count: 1 };
  }

  add(f: TelemetryPacket): void {
    this.frames++;
    const acc = f.acc;
    const air = firstFinite(acc?.airTempC, acc?.acEvo?.airTempC, f.AirTemp, f.f1?.airTemperature);
    const road = firstFinite(acc?.roadTempC, acc?.acEvo?.roadTempC, f.TrackTemp, f.f1?.trackTemperature);
    if (air != null) { this.air = this.addRange(this.air, air); this.anyData = true; }
    if (road != null) { this.road = this.addRange(this.road, road); this.anyData = true; }
    const accRain = acc?.rainIntensity;
    const f1Rain = f.RainPercent ?? f.f1?.rainPercentage;
    if (accRain != null && Number.isFinite(accRain)) { this.rainSum += accRain; this.rainCount++; this.anyData = true; }
    else if (f1Rain != null && Number.isFinite(f1Rain)) { this.rainSum += f1Rain / 100; this.rainCount++; this.anyData = true; }
    if (acc?.windSpeed != null && Number.isFinite(acc.windSpeed)) { this.windSum += acc.windSpeed; this.windCount++; }
    if (acc?.windDirection != null && Number.isFinite(acc.windDirection)) { this.windDirectionSum += acc.windDirection; this.windDirectionCount++; }
    const grip = acc?.trackGripStatus;
    if (grip && grip !== "unknown") { this.gripCounts.set(grip, (this.gripCounts.get(grip) ?? 0) + 1); this.anyData = true; }
    if (acc?.acEvo?.startingGrip && acc.acEvo.startingGrip !== "unknown") { this.startingGrip = acc.acEvo.startingGrip; this.anyData = true; }
    if (acc?.acEvo?.isStaticWeather != null) this.staticWeather = acc.acEvo.isStaticWeather;
  }

  result(): TrackConditions | null {
    if (!this.anyData) return null;
    let trackGripStatus = "unknown";
    let topGripCount = 0;
    for (const [grip, count] of this.gripCounts) if (count > topGripCount) { trackGripStatus = grip; topGripCount = count; }
    const meanRain = this.rainCount ? this.rainSum / this.rainCount : 0;
    const range = (value: NumericRange | null) => value ? {
      min: Math.round(value.min * 10) / 10,
      max: Math.round(value.max * 10) / 10,
      avg: Math.round(value.sum / value.count * 10) / 10,
    } : null;
    return {
      frames: this.frames,
      airTempC: range(this.air),
      roadTempC: range(this.road),
      rainIntensity: Math.round(meanRain * 100) / 100,
      wet: meanRain > WET_RAIN_FRACTION,
      trackGripStatus,
      windSpeedKmh: Math.round((this.windCount ? this.windSum / this.windCount : 0) * 10) / 10,
      windDirectionDeg: Math.round(this.windDirectionCount ? this.windDirectionSum / this.windDirectionCount : 0),
      startingGrip: this.startingGrip,
      staticWeather: this.staticWeather,
    };
  }
}

export function telemetryToTrackConditions(input: TelemetryPacket[] | TelemetryPacket): TrackConditions | null {
  const accumulator = new TrackConditionsAccumulator();
  if (Array.isArray(input)) {
    for (const packet of input) accumulator.add(packet);
  } else accumulator.add(input as TelemetryPacket);
  return accumulator.result();
}

/** Human-readable one-liner summary of {@link telemetryToTrackConditions}. */
export function formatTrackConditions(tc: TrackConditions): string {
  const parts: string[] = [];
  if (tc.airTempC) parts.push(`air ${tc.airTempC.avg}°C`);
  if (tc.roadTempC) parts.push(`track ${tc.roadTempC.avg}°C (${tc.roadTempC.min}–${tc.roadTempC.max})`);
  parts.push(tc.wet ? `WET (rain ${Math.round(tc.rainIntensity * 100)}%)` : "dry");
  if (tc.startingGrip) parts.push(`grip ${tc.startingGrip}`);
  else if (tc.trackGripStatus !== "unknown") parts.push(`grip ${tc.trackGripStatus}`);
  if (tc.windSpeedKmh > 0) parts.push(`wind ${tc.windSpeedKmh}km/h @${tc.windDirectionDeg}°`);
  if (tc.staticWeather === false) parts.push("dynamic weather");
  return parts.join(", ");
}
