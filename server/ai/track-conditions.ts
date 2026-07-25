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
import type { TelemetryPacket } from "../../shared/types";

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
export const WET_RAIN_FRACTION = 0.02;

function firstFinite(...vals: (number | null | undefined)[]): number | null {
  for (const v of vals) if (v != null && Number.isFinite(v)) return v;
  return null;
}

function summariseNumeric(values: number[]): { min: number; max: number; avg: number } | null {
  if (values.length === 0) return null;
  let min = values[0]!;
  let max = values[0]!;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return { min: round(min), max: round(max), avg: round(sum / values.length) };
}

export function telemetryToTrackConditions(packets: TelemetryPacket[]): TrackConditions | null {
  if (packets.length === 0) return null;

  const airTemps: number[] = [];
  const roadTemps: number[] = [];
  const rain: number[] = [];
  const wind: number[] = [];
  const windDir: number[] = [];
  const gripCounts = new Map<string, number>();
  let startingGrip: string | null = null;
  let staticWeather: boolean | null = null;
  let anyData = false;

  for (const f of packets) {
    const acc = f.acc;
    // Air / road temp: ACC-family on acc / acc.acEvo; F1 top-level + f1 mirror.
    const air = firstFinite(acc?.airTempC, acc?.acEvo?.airTempC, f.AirTemp, f.f1?.airTemperature);
    const road = firstFinite(acc?.roadTempC, acc?.acEvo?.roadTempC, f.TrackTemp, f.f1?.trackTemperature);
    if (air != null) { airTemps.push(air); anyData = true; }
    if (road != null) { roadTemps.push(road); anyData = true; }

    // Rain: ACC rainIntensity is already 0..1; F1 RainPercent is 0-100.
    const accRain = acc?.rainIntensity;
    const f1Rain = f.RainPercent ?? f.f1?.rainPercentage;
    if (accRain != null && Number.isFinite(accRain)) { rain.push(accRain); anyData = true; }
    else if (f1Rain != null && Number.isFinite(f1Rain)) { rain.push(f1Rain / 100); anyData = true; }

    if (acc?.windSpeed != null && Number.isFinite(acc.windSpeed)) wind.push(acc.windSpeed);
    if (acc?.windDirection != null && Number.isFinite(acc.windDirection)) windDir.push(acc.windDirection);

    const grip = acc?.trackGripStatus;
    if (grip && grip !== "unknown") { gripCounts.set(grip, (gripCounts.get(grip) ?? 0) + 1); anyData = true; }
    if (acc?.acEvo?.startingGrip && acc.acEvo.startingGrip !== "unknown") {
      startingGrip = acc.acEvo.startingGrip;
      anyData = true;
    }
    if (acc?.acEvo?.isStaticWeather != null) staticWeather = acc.acEvo.isStaticWeather;
  }

  if (!anyData) return null;

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const meanRain = mean(rain);
  let topGrip = "unknown";
  let topGripN = 0;
  for (const [g, n] of gripCounts) {
    if (n > topGripN) { topGrip = g; topGripN = n; }
  }

  return {
    frames: packets.length,
    airTempC: summariseNumeric(airTemps),
    roadTempC: summariseNumeric(roadTemps),
    rainIntensity: Math.round(meanRain * 100) / 100,
    wet: meanRain > WET_RAIN_FRACTION,
    trackGripStatus: topGrip,
    windSpeedKmh: Math.round(mean(wind) * 10) / 10,
    windDirectionDeg: Math.round(mean(windDir)),
    startingGrip,
    staticWeather,
  };
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
