import type { TelemetryVariableId } from "../../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import { semanticWheelNumbers, type SemanticAnalysisFrame } from "./track-map/types";

export type TireSurfaceBand = "inner" | "middle" | "outer";
export type TireTemperatureKind = TireSurfaceBand | "surface" | "core" | "carcass";
export interface TireTemperatureReading { kind: TireTemperatureKind; value: number | null }
export interface TireTemperatureProfile {
  representative: number | null;
  inner: number | null;
  middle: number | null;
  outer: number | null;
  core: number | null;
}

const PROFILE_IDS = {
  representative: "tire.temperature.surface.representative",
  inner: "tire.temperature.surface.inner",
  middle: "tire.temperature.surface.middle",
  outer: "tire.temperature.surface.outer",
  core: "tire.temperature.core",
} as const satisfies Record<keyof TireTemperatureProfile, TelemetryVariableId>;

export function tireTemperatureProfile(frame: SemanticAnalysisFrame, wheelIndex: number): TireTemperatureProfile {
  return {
    representative: semanticWheelNumbers(frame, PROFILE_IDS.representative)[wheelIndex] ?? null,
    inner: semanticWheelNumbers(frame, PROFILE_IDS.inner)[wheelIndex] ?? null,
    middle: semanticWheelNumbers(frame, PROFILE_IDS.middle)[wheelIndex] ?? null,
    outer: semanticWheelNumbers(frame, PROFILE_IDS.outer)[wheelIndex] ?? null,
    core: semanticWheelNumbers(frame, PROFILE_IDS.core)[wheelIndex] ?? null,
  };
}

export function hasSurfaceTemperatureProfile(frame: SemanticAnalysisFrame): boolean {
  return (Object.keys(PROFILE_IDS) as Array<keyof TireTemperatureProfile>)
    .filter((key) => key !== "representative" && key !== "core")
    .some((key) => semanticWheelNumbers(frame, PROFILE_IDS[key]).some((value) => value != null));
}

export function tireTemperatureReadings(
  frame: SemanticAnalysisFrame,
  wheelIndex: number,
  side: "left" | "right",
  primarySemanticId: TelemetryVariableId,
  primaryKind: TireTemperatureKind,
): TireTemperatureReading[] {
  const profile = tireTemperatureProfile(frame, wheelIndex);
  if (hasSurfaceTemperatureProfile(frame)) {
    const kinds: TireSurfaceBand[] = side === "left" ? ["outer", "middle", "inner"] : ["inner", "middle", "outer"];
    return [...kinds.map((kind) => ({ kind, value: profile[kind] })), { kind: "core", value: profile.core }];
  }
  const primary = semanticWheelNumbers(frame, primarySemanticId)[wheelIndex] ?? null;
  const readings: TireTemperatureReading[] = [{ kind: primaryKind, value: primary }];
  if (primaryKind === "surface" && profile.core != null) readings.push({ kind: "core", value: profile.core });
  return readings;
}
