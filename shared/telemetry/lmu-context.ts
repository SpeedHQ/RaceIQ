import { isLmuRestValue, LMU_REST_CHANNELS, type LmuRestSemanticId } from "./lmu-rest-channels";
import type { LmuLiveContext } from "./lmu";
import type { LmuSupplementalObservation } from "./lmu-supplemental";
import type { ResolutionProvenance, ResolvedValue, TelemetryTimestamp } from "./resolver/contracts";
import type { TelemetryPacket } from "./types";

export type LmuTimestampWire = Exclude<TelemetryTimestamp, { domain: "monotonic" }> | { readonly domain: "monotonic"; readonly nanoseconds: string };
export interface LmuProvenanceWire extends Omit<ResolutionProvenance, "observedAt" | "sourceObservation"> {
  observedAt: LmuTimestampWire;
  sourceObservation?: { timestamp: LmuTimestampWire; updateSequence: string };
}
export interface LmuObservationWire extends Omit<LmuSupplementalObservation, "acquiredAt" | "observation"> {
  acquiredAt: LmuTimestampWire;
  observation: Omit<ResolvedValue<unknown>, "provenance"> & { provenance: LmuProvenanceWire };
}
export interface LmuLiveContextWire extends Omit<LmuLiveContext, "key" | "supplemental"> {
  key: { sessionKey: string; captureSequence: string; frameTime: LmuTimestampWire };
  supplemental: readonly LmuObservationWire[];
}
const decimal = /^(0|[1-9][0-9]{0,39})$/;
const STATES = ["ok", "missing", "stale", "invalid", "not-applicable", "error"];
const MAPPINGS = ["direct", "normalized", "derived", "simplified", "unavailable"];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): value is LmuTimestampWire {
  if (!record(value)) return false;
  if (value.domain === "monotonic") return typeof value.nanoseconds === "string" && decimal.test(value.nanoseconds);
  return (value.domain === "wall-clock" || value.domain === "session") && typeof value.milliseconds === "number" && Number.isFinite(value.milliseconds) && value.milliseconds >= 0;
}
function fraction(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function validObservation(value: unknown): value is LmuObservationWire {
  if (!record(value) || typeof value.semanticId !== "string" || !Object.hasOwn(LMU_REST_CHANNELS, value.semanticId)) return false;
  const spec = LMU_REST_CHANNELS[value.semanticId as LmuRestSemanticId];
  if (value.endpoint !== spec.endpoint || value.applicability !== spec.applicability || value.method !== "GET" || typeof value.sessionKey !== "string" || !value.sessionKey || !timestamp(value.acquiredAt) || (value.responseVersion !== null && typeof value.responseVersion !== "string")) return false;
  if (spec.applicability === "session" ? value.vehicleId !== null : typeof value.vehicleId !== "number" || !Number.isSafeInteger(value.vehicleId) || value.vehicleId < 0) return false;
  const r = value.observation;
  if (!record(r) || r.semanticId !== value.semanticId || r.unit !== spec.unit || typeof r.state !== "string" || !STATES.includes(r.state) || typeof r.mappingStatus !== "string" || !MAPPINGS.includes(r.mappingStatus)) return false;
  if (r.state === "ok" ? r.value === null || !isLmuRestValue(value.semanticId, r.value) : r.value !== null) return false;
  if (r.confidence !== null && !fraction(r.confidence)) return false;
  if (typeof r.freshness !== "string" || !["fresh", "stale", "unknown"].includes(r.freshness) || typeof r.schemaVersion !== "string" || !Array.isArray(r.limitations) || r.limitations.length > 32 || !r.limitations.every((item) => typeof item === "string" && item.length <= 4096)) return false;
  const c = r.confidenceComponents;
  if (!record(c) || !fraction(c.semanticFidelity) || !fraction(c.inputCompleteness) || (c.freshness !== null && !fraction(c.freshness)) || (c.derivationReliability !== undefined && !fraction(c.derivationReliability))) return false;
  const p = r.provenance;
  if (!record(p) || p.simulator !== "lmu" || !timestamp(p.observedAt) || !["parserId", "parserVersion", "resolverVersion", "catalogVersion", "catalogHash"].every((key) => typeof p[key] === "string" && (p[key] as string).length > 0)) return false;
  if ((p.sourceChannel !== undefined && typeof p.sourceChannel !== "string") || (p.sourceUnit !== undefined && typeof p.sourceUnit !== "string")) return false;
  if (p.derivation !== undefined && (!record(p.derivation) || !["id", "version", "codeHash"].every((key) => typeof (p.derivation as Record<string, unknown>)[key] === "string"))) return false;
  const source = p.sourceObservation;
  return source === undefined || record(source) && timestamp(source.timestamp) && typeof source.updateSequence === "string" && decimal.test(source.updateSequence);
}
export function isLmuLiveContextWire(value: unknown): value is LmuLiveContextWire {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.key) || Object.hasOwn(value, "competitors")) return false;
  const key = value.key;
  if (typeof key.sessionKey !== "string" || !key.sessionKey || key.sessionKey.length > 2048 || typeof key.captureSequence !== "string" || !decimal.test(key.captureSequence) || !timestamp(key.frameTime)) return false;
  if (value.status !== "active" && value.status !== "unavailable") return false;
  if (value.playerVehicleId !== null && (typeof value.playerVehicleId !== "number" || !Number.isSafeInteger(value.playerVehicleId) || value.playerVehicleId < 0)) return false;
  if (value.status === "active" && value.playerVehicleId === null) return false;
  if (!Array.isArray(value.supplemental) || value.supplemental.length > Object.keys(LMU_REST_CHANNELS).length) return false;
  const ids = new Set<string>();
  return value.supplemental.every((item: unknown) => {
    if (!validObservation(item) || item.sessionKey !== key.sessionKey || (item.applicability === "player-vehicle" && item.vehicleId !== value.playerVehicleId) || ids.has(item.semanticId)) return false;
    ids.add(item.semanticId);
    return true;
  });
}
function encodeTimestamp(value: TelemetryTimestamp): LmuTimestampWire {
  return value.domain === "monotonic" ? { domain: "monotonic", nanoseconds: value.nanoseconds.toString() } : value;
}
function decodeTimestamp(value: LmuTimestampWire): TelemetryTimestamp {
  return value.domain === "monotonic" ? { domain: "monotonic", nanoseconds: BigInt(value.nanoseconds) } : value;
}
export function encodeLmuContext(value: LmuLiveContext): LmuLiveContextWire {
  const supplemental = value.supplemental.map((entry): LmuObservationWire => {
    const p = entry.observation.provenance;
    const { sourceObservation, ...provenance } = p;
    return { ...entry, acquiredAt: encodeTimestamp(entry.acquiredAt), observation: { ...entry.observation, provenance: { ...provenance, observedAt: encodeTimestamp(p.observedAt), ...(sourceObservation ? { sourceObservation: { timestamp: encodeTimestamp(sourceObservation.timestamp), updateSequence: sourceObservation.updateSequence.toString() } } : {}) } } };
  });
  const wire: LmuLiveContextWire = { ...value, key: { ...value.key, frameTime: encodeTimestamp(value.key.frameTime) }, supplemental };
  if (!isLmuLiveContextWire(wire)) throw new TypeError("Invalid LMU live context");
  return wire;
}
export function decodeLmuContext(value: unknown): LmuLiveContext | null {
  if (!isLmuLiveContextWire(value)) return null;
  const supplemental = value.supplemental.map((entry): LmuSupplementalObservation => {
    const p = entry.observation.provenance;
    const { sourceObservation, ...provenance } = p;
    return { ...entry, acquiredAt: decodeTimestamp(entry.acquiredAt), observation: { ...entry.observation, provenance: { ...provenance, observedAt: decodeTimestamp(p.observedAt), ...(sourceObservation ? { sourceObservation: { timestamp: decodeTimestamp(sourceObservation.timestamp), updateSequence: BigInt(sourceObservation.updateSequence) } } : {}) } } };
  });
  return { ...value, key: { ...value.key, frameTime: decodeTimestamp(value.key.frameTime) }, supplemental };
}

export type LmuPacketWire = Omit<TelemetryPacket, "lmuContext"> & { lmuContext?: LmuLiveContextWire };
export function encodeLmuPacket(packet: TelemetryPacket): LmuPacketWire {
  if (!packet.lmuContext) return packet as LmuPacketWire;
  return { ...packet, lmuContext: encodeLmuContext(packet.lmuContext) };
}
export function decodeLmuPacket(packet: LmuPacketWire): TelemetryPacket | null {
  const { lmuContext, ...native } = packet;
  if (!lmuContext) return native;
  const context = decodeLmuContext(lmuContext);
  return context ? { ...native, lmuContext: context } : null;
}
