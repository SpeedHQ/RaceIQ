/**
 * Deterministic weather and track-surface summary from resolver-backed
 * semantic telemetry. Values stay in catalog canonical units until display.
 */
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";

/** Semantic values required by {@link telemetryToTrackConditions}. */
export const TRACK_CONDITION_SEMANTIC_IDS = [
  "weather.air-temp",
  "weather.track-temp",
  "weather.rain-intensity",
  "weather.rain-percent",
  "weather.wind-speed",
  "weather.wind-direction",
  "weather.track-grip-status",
  "weather.starting-grip",
  "weather.is-static-weather",
  "weather.track-rubber-state",
  "weather.track-wetness",
  "weather.weather-declared-wet",
] as const satisfies readonly TelemetryVariableId[];

export interface TrackConditions {
  frames: number;
  /** Air / road surface temperature (°C) across the lap. null when unrecorded. */
  airTempC: { min: number; max: number; avg: number } | null;
  roadTempC: { min: number; max: number; avg: number } | null;
  /** Mean rain fraction 0..1; null when precipitation is unavailable. */
  rainIntensity: number | null;
  wet: boolean | null;
  /** Most-common non-empty grip descriptor across frames. */
  trackGripStatus: string | null;
  /** Latest available iRacing session rubber-state descriptor. */
  trackRubberState: string | null;
  /** Latest native wetness category; null when unavailable. */
  trackWetness: number | null;
  /** Canonical wind speed is m/s; converted only for this km/h display field. */
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  /** AC-EVO only: static session grip label + whether weather is fixed. */
  startingGrip: string | null;
  staticWeather: boolean | null;
}

/** Mean rain fraction above which the lap is treated as wet. */
const WET_RAIN_FRACTION = 0.02;

function semanticNumber(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId): number | null {
  const value = sample.values[semanticId];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function semanticString(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId): string | null {
  const value = sample.values[semanticId];
  return typeof value === "string" && value.length > 0 && value !== "unknown" ? value : null;
}

function semanticBoolean(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId): boolean | null {
  const value = sample.values[semanticId];
  return typeof value === "boolean" ? value : null;
}

function rubberState(sample: SemanticTelemetrySample): string | null {
  const value = sample.values["weather.track-rubber-state"];
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) return entry;
    if (typeof entry === "object" && entry !== null && "value" in entry && typeof entry.value === "string" && entry.value.length > 0) {
      return entry.value;
    }
  }
  return null;
}

function summariseNumeric(values: readonly number[]): { min: number; max: number; avg: number } | null {
  const [first] = values;
  if (first === undefined) return null;
  let min = first;
  let max = first;
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const round = (value: number) => Math.round(value * 10) / 10;
  return { min: round(min), max: round(max), avg: round(sum / values.length) };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

export function telemetryToTrackConditions(samples: readonly SemanticTelemetrySample[]): TrackConditions | null {
  if (samples.length === 0) return null;

  const airTemps: number[] = [];
  const roadTemps: number[] = [];
  const rain: number[] = [];
  const wind: number[] = [];
  const windDir: number[] = [];
  const gripCounts = new Map<string, number>();
  let startingGrip: string | null = null;
  let staticWeather: boolean | null = null;
  let trackRubberState: string | null = null;
  let trackWetness: number | null = null;
  let weatherDeclaredWet: boolean | null = null;
  let anyData = false;

  for (const sample of samples) {
    const air = semanticNumber(sample, "weather.air-temp");
    const road = semanticNumber(sample, "weather.track-temp");
    if (air != null) {
      airTemps.push(air);
      anyData = true;
    }
    if (road != null) {
      roadTemps.push(road);
      anyData = true;
    }

    const rainIntensity = semanticNumber(sample, "weather.rain-intensity");
    const rainPercent = semanticNumber(sample, "weather.rain-percent");
    if (rainIntensity != null) {
      rain.push(rainIntensity);
      anyData = true;
    } else if (rainPercent != null) {
      rain.push(rainPercent / 100);
      anyData = true;
    }

    const windSpeed = semanticNumber(sample, "weather.wind-speed");
    const direction = semanticNumber(sample, "weather.wind-direction");
    if (windSpeed != null) {
      wind.push(windSpeed);
      anyData = true;
    }
    if (direction != null) {
      windDir.push(direction);
      anyData = true;
    }

    const grip = semanticString(sample, "weather.track-grip-status");
    if (grip != null) {
      gripCounts.set(grip, (gripCounts.get(grip) ?? 0) + 1);
      anyData = true;
    }
    const starting = semanticString(sample, "weather.starting-grip");
    if (starting != null) {
      startingGrip = starting;
      anyData = true;
    }
    const isStatic = semanticBoolean(sample, "weather.is-static-weather");
    if (isStatic != null) {
      staticWeather = isStatic;
      anyData = true;
    }
    const rubber = rubberState(sample);
    if (rubber != null) {
      trackRubberState = rubber;
      anyData = true;
    }
    const wetness = semanticNumber(sample, "weather.track-wetness");
    if (wetness != null) {
      trackWetness = wetness;
      anyData = true;
    }
    const declaredWet = semanticBoolean(sample, "weather.weather-declared-wet");
    if (declaredWet != null) {
      weatherDeclaredWet = declaredWet;
      anyData = true;
    }
  }

  if (!anyData) return null;

  const meanRain = mean(rain);
  let trackGripStatus: string | null = null;
  let topGripCount = 0;
  for (const [grip, count] of gripCounts) {
    if (count > topGripCount) {
      trackGripStatus = grip;
      topGripCount = count;
    }
  }
  const meanWind = mean(wind);
  const meanWindDirection = mean(windDir);

  return {
    frames: samples.length,
    airTempC: summariseNumeric(airTemps),
    roadTempC: summariseNumeric(roadTemps),
    rainIntensity: meanRain == null ? null : Math.round(meanRain * 100) / 100,
    wet: meanRain == null ? weatherDeclaredWet : weatherDeclaredWet === true || meanRain > WET_RAIN_FRACTION,
    trackGripStatus,
    trackRubberState,
    trackWetness,
    windSpeedKmh: meanWind == null ? null : Math.round(meanWind * 3.6 * 10) / 10,
    windDirectionDeg: meanWindDirection == null ? null : Math.round(meanWindDirection),
    startingGrip,
    staticWeather,
  };
}

/** Human-readable one-liner summary of {@link telemetryToTrackConditions}. */
export function formatTrackConditions(tc: TrackConditions): string {
  const parts: string[] = [];
  if (tc.airTempC) parts.push(`air ${tc.airTempC.avg}°C`);
  if (tc.roadTempC) parts.push(`track ${tc.roadTempC.avg}°C (${tc.roadTempC.min}–${tc.roadTempC.max})`);
  if (tc.wet === true) {
    parts.push(tc.rainIntensity == null ? "WET" : `WET (rain ${Math.round(tc.rainIntensity * 100)}%)`);
  } else if (tc.wet === false) {
    parts.push("dry");
  }
  if (tc.startingGrip) parts.push(`grip ${tc.startingGrip}`);
  else if (tc.trackGripStatus) parts.push(`grip ${tc.trackGripStatus}`);
  else if (tc.trackRubberState) parts.push(`rubber ${tc.trackRubberState}`);
  if (tc.trackWetness != null) parts.push(`wetness ${tc.trackWetness}`);
  if (tc.windSpeedKmh != null && tc.windSpeedKmh > 0) {
    parts.push(tc.windDirectionDeg == null ? `wind ${tc.windSpeedKmh}km/h` : `wind ${tc.windSpeedKmh}km/h @${tc.windDirectionDeg}°`);
  }
  if (tc.staticWeather === false) parts.push("dynamic weather");
  return parts.join(", ");
}
