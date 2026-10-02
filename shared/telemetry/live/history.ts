import type { CanonicalTelemetryScalar } from "../replay/contracts";

export interface LiveTelemetryHistoryV1 {
  schemaId: string | null;
  sampleIntervalMs: number;
  series: Readonly<Record<string, readonly CanonicalTelemetryScalar[]>>;
}
