import type { CanonicalTelemetryScalar } from "@raceiq/shared/telemetry/replay/contracts";

export interface LiveTelemetryHistoryV1 {
  schemaId: string | null;
  sampleIntervalMs: number;
  series: Readonly<Record<string, readonly CanonicalTelemetryScalar[]>>;
}
