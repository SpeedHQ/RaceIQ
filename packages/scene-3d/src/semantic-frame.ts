import { isTelemetryVariableId } from "@raceiq/shared/telemetry/catalog/query";
import type { TelemetryVariableId } from "@raceiq/shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { LmuLiveContextWire } from "@raceiq/shared/telemetry/lmu-context";

export interface SemanticAnalysisFrame {
  values: Readonly<Record<string, unknown>>;
  states: Readonly<Record<string, string | undefined>>;
  freshness: Readonly<Record<string, string | undefined>>;
  source?: "motec" | "cloud-import" | null;
  units?: Readonly<Record<string, string | null | undefined>>;
  lmu?: LmuLiveContextWire;
  observedAtMs?: number;
  observedAt?: { domain: string; milliseconds: number };
}

export interface SemanticValueEntry {
  semanticId: string;
  value: unknown;
}

export function semanticValues(entries: readonly SemanticValueEntry[]): SemanticAnalysisFrame["values"] {
  const values: Partial<Record<TelemetryVariableId, unknown>> = {};
  for (const entry of entries) {
    if (isTelemetryVariableId(entry.semanticId)) values[entry.semanticId] = entry.value;
  }
  return values;
}

export const semanticNumber = (frame: SemanticAnalysisFrame | undefined, id: TelemetryVariableId): number | null => {
  const value = frame?.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const semanticWheelNumbers = (
  frame: SemanticAnalysisFrame | undefined,
  id: TelemetryVariableId,
): readonly [number | null, number | null, number | null, number | null] => {
  const value = frame?.values[id];
  if (!Array.isArray(value)) return [null, null, null, null];
  return [0, 1, 2, 3].map((index) => {
    const item = value[index];
    return typeof item === "number" && Number.isFinite(item) ? item : null;
  }) as [number | null, number | null, number | null, number | null];
};

export const semanticBoolean = (frame: SemanticAnalysisFrame | undefined, id: TelemetryVariableId): boolean => semanticNumber(frame, id) === 1;
