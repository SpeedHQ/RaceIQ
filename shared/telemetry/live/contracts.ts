import type { GameId } from "../../games/ids";
import type { LivePitData, LiveSectorData } from "../../racing/live/types";
import type { TuneIssue } from "../../racing/tuning/issues";
import type { MappingStatus } from "../derivations/contracts";
import type { TelemetryPacket } from "../types";
import type { FreshnessState, ResolutionState } from "../resolver/contracts";
import type { CanonicalTelemetryScalar } from "../replay/contracts";

export const LIVE_TELEMETRY_PROTOCOL_VERSION = 1 as const;

export interface LiveTelemetryDefinitionV1 { semanticId: string; unit: string | null; mappingStatus: MappingStatus; schemaVersion: string; limitations: readonly string[]; }
export interface LiveTelemetrySchemaMessageV1 { type: "telemetry-schema"; protocolVersion: 1; schemaId: string; simulator: GameId; catalogVersion: string; catalogHash: string; catalogSchemaVersion: string; parserVersion: string; resolverVersion: string; derivationVersion: string; definitions: readonly LiveTelemetryDefinitionV1[]; }
export interface LiveTelemetryFrameMessageV1 { type: "telemetry-frame"; protocolVersion: 1; schemaId: string; streamId: string; sessionId: number | null; sequence: number; observedAt: { domain: "session" | "wall-clock"; milliseconds: number }; receivedAtMs: number; values: readonly CanonicalTelemetryScalar[]; states?: Readonly<Record<number, Exclude<ResolutionState, "ok">>>; freshness?: Readonly<Record<number, Exclude<FreshnessState, "fresh">>>; context: { sectors?: LiveSectorData; pit?: LivePitData; liveIssues?: readonly TuneIssue[]; }; }
export type DevTelemetryControlMessageV1 = { type: "subscribe"; channel: "dev-telemetry" } | { type: "unsubscribe"; channel: "dev-telemetry" };
export interface DevTelemetrySubscriptionMessageV1 { type: "subscription"; channel: "dev-telemetry"; subscribed: boolean; error?: "not-available" | "invalid-message"; }
export interface DevTelemetryPacketMessageV1 { type: "dev-telemetry"; protocolVersion: 1; packet: TelemetryPacket; }

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
export function isLiveTelemetrySchemaMessageV1(value: unknown): value is LiveTelemetrySchemaMessageV1 {
  const v = record(value);
  return !!v && v.type === "telemetry-schema" && v.protocolVersion === 1 && typeof v.schemaId === "string" && Array.isArray(v.definitions);
}
export function isLiveTelemetryFrameMessageV1(value: unknown, schema?: LiveTelemetrySchemaMessageV1): value is LiveTelemetryFrameMessageV1 {
  const v = record(value);
  const observed = record(v?.observedAt);
  return !!v && v.type === "telemetry-frame" && v.protocolVersion === 1 && typeof v.schemaId === "string" && typeof v.streamId === "string" &&
    (v.sessionId === null || finite(v.sessionId)) && finite(v.sequence) && finite(v.receivedAtMs) && !!observed &&
    (observed.domain === "session" || observed.domain === "wall-clock") && finite(observed.milliseconds) &&
    Array.isArray(v.values) && (!schema || v.values.length === schema.definitions.length);
}
export function isDevTelemetryControlMessageV1(value: unknown): value is DevTelemetryControlMessageV1 {
  const v = record(value);
  return !!v && v.channel === "dev-telemetry" && (v.type === "subscribe" || v.type === "unsubscribe");
}
export function isDevTelemetrySubscriptionMessageV1(value: unknown): value is DevTelemetrySubscriptionMessageV1 {
  const v = record(value);
  return !!v && v.type === "subscription" && v.channel === "dev-telemetry" && typeof v.subscribed === "boolean" &&
    (v.error === undefined || v.error === "not-available" || v.error === "invalid-message");
}
export function isDevTelemetryPacketMessageV1(value: unknown): value is DevTelemetryPacketMessageV1 {
  const v = record(value);
  const packet = record(v?.packet);
  return !!v && v.type === "dev-telemetry" && v.protocolVersion === 1 && !!packet &&
    typeof packet.gameId === "string" && finite(packet.TimestampMS);
}
