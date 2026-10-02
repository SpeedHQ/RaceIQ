import type { GameId } from "../../shared/games/ids";
import type { LiveSectorData } from "../../shared/racing/live/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import type { CanonicalTelemetryScalar } from "../../shared/telemetry/replay/contracts";
import type { LiveTelemetryDefinitionV1, LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
import type { ResolvedValue } from "../../shared/telemetry/resolver/contracts";

export function encodeCanonicalLiveValue(value: unknown, semanticId = "value"): CanonicalTelemetryScalar {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") { if (Number.isFinite(value)) return value; throw new TypeError(`Non-finite live value: ${semanticId}`); }
  if (Array.isArray(value)) return value.map((v) => encodeCanonicalLiveValue(v, semanticId));
  if (value && typeof value === "object") {
    const out: Record<string, CanonicalTelemetryScalar> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = encodeCanonicalLiveValue((value as Record<string, unknown>)[key], `${semanticId}.${key}`);
    return out;
  }
  throw new TypeError(`Unsupported live value: ${semanticId}`);
}

export function encodeLiveSchema(definitions: readonly LiveTelemetryDefinitionV1[], meta: Omit<LiveTelemetrySchemaMessageV1, "type" | "protocolVersion" | "definitions">): LiveTelemetrySchemaMessageV1 {
  return { type: "telemetry-schema", protocolVersion: 1, ...meta, definitions: definitions.map((d) => ({ ...d, limitations: [...d.limitations] })) };
}

export function encodeLiveFrame(input: Omit<LiveTelemetryFrameMessageV1, "type" | "protocolVersion" | "values"> & { values: readonly (CanonicalTelemetryScalar | ResolvedValue<unknown> | undefined)[] }): LiveTelemetryFrameMessageV1 {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw new RangeError("Live sequence must be non-negative safe integer");
  const values = input.values.map((value, i) => {
    if (value === undefined) return null;
    if (value && typeof value === "object" && "semanticId" in value && "state" in value) return value.state === "ok" ? encodeCanonicalLiveValue(value.value, String(value.semanticId)) : null;
    return encodeCanonicalLiveValue(value, `slot-${i}`);
  });
  return { type: "telemetry-frame", protocolVersion: 1, ...input, values };
}

export type LiveWireContext = { sectors?: LiveSectorData; pit?: unknown; liveIssues?: readonly TuneIssue[] };
export type { GameId };
