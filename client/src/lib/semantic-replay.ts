import { TELEMETRY_CATALOG } from "@shared/telemetry/catalog/data";
import type { TelemetryPacket } from "@shared/telemetry/types";
import type { SemanticLapTelemetry } from "../hooks/laps";

/**
 * Builds the legacy analysis frame shape from canonical catalog values.
 * Source is semantic replay only; native lap telemetry is never fetched by
 * semantic consumers. Packet-shaped leaf APIs can migrate incrementally.
 */
export function semanticReplayToAnalysisFrames(replay: SemanticLapTelemetry | undefined): TelemetryPacket[] {
  if (!replay) return [];
  const variables = new Map(TELEMETRY_CATALOG.variables.map((variable) => [variable.id, variable]));
  return replay.envelopes.map((envelope) => {
    const frame: Record<string, unknown> = {
      gameId: envelope.simulator,
      TimestampMS: envelope.observedAt.milliseconds,
    };
    for (const variable of TELEMETRY_CATALOG.variables) {
      for (const field of variable.packetFields ?? []) {
        frame[field] ??= 0;
      }
    }
    for (const entry of envelope.values) {
      if (entry.state && entry.state !== "ok") continue;
      const fields = variables.get(entry.semanticId as typeof TELEMETRY_CATALOG.variables[number]["id"])?.packetFields ?? [];
      if (fields.length > 1 && Array.isArray(entry.value)) {
        const values = entry.value as readonly unknown[];
        fields.forEach((field, index) => {
          frame[field] = values[index];
        });
      } else {
        for (const field of fields) frame[field] = entry.value;
      }
    }
    return frame as unknown as TelemetryPacket;
  });
}
