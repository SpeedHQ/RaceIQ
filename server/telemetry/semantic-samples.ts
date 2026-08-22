import type { CanonicalTelemetryScalar, SemanticTelemetryReplay, SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import { isTelemetryVariableId } from "../../shared/telemetry/catalog/query";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";

/** Convert resolver replay envelopes into consumer-safe semantic frames. */
export function semanticSamplesFromReplay(replay: SemanticTelemetryReplay): SemanticTelemetrySample[] {
  return replay.envelopes.map((envelope) => {
    const values: Partial<Record<TelemetryVariableId, CanonicalTelemetryScalar>> = {};
    for (const entry of envelope.values) {
      if (entry.state === "ok" && (entry.freshness === undefined || entry.freshness === "fresh") && isTelemetryVariableId(entry.semanticId)) {
        values[entry.semanticId] = entry.value;
      }
    }
    return {
      sequence: envelope.sequence.toString(),
      observedAtMs: envelope.observedAt.domain === "monotonic" ? Number(envelope.observedAt.nanoseconds) / 1_000_000 : envelope.observedAt.milliseconds,
      values,
    };
  });
}

export function semanticNumber(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId): number | null {
  const value = sample.values[semanticId];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function semanticBoolean(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId): boolean | null {
  const value = sample.values[semanticId];
  return typeof value === "boolean" ? value : null;
}

export function semanticFixedNumbers(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId, length: 4): readonly [number, number, number, number] | null;
export function semanticFixedNumbers(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId, length: number): readonly number[] | null;
export function semanticFixedNumbers(sample: SemanticTelemetrySample, semanticId: TelemetryVariableId, length: number): readonly number[] | null {
  const value = sample.values[semanticId];
  if (!Array.isArray(value) || value.length !== length) return null;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ? value : null;
}
