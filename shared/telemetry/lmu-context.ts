import { isLmuRestValue, LMU_REST_CHANNELS, type LmuRestSemanticId } from "./lmu-rest-channels";
import type { LmuCompetitor, LmuLiveContext } from "./lmu";
import { TELEMETRY_CATALOG } from "./catalog/data";
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
export interface LmuResolvedValueWire<T = unknown> extends Omit<ResolvedValue<T>, "provenance"> {
  provenance: LmuProvenanceWire;
}
export interface LmuCompetitorWire extends Omit<LmuCompetitor, "channels"> {
  channels: Readonly<Record<string, LmuResolvedValueWire>>;
}
export interface LmuLiveContextWire extends Omit<LmuLiveContext, "key" | "supplemental" | "competitors"> {
  key: { sessionKey: string; captureSequence: string; frameTime: LmuTimestampWire };
  supplemental: readonly LmuObservationWire[];
  competitors?: readonly LmuCompetitorWire[];
}
const decimal = /^(0|[1-9][0-9]{0,39})$/;
const STATES = ["ok", "missing", "stale", "invalid", "not-applicable", "error"];
const MAPPINGS = ["direct", "normalized", "derived", "simplified", "unavailable"];
const TELEMETRY_SEMANTIC_IDS = new Set<string>(TELEMETRY_CATALOG.variables.map((definition) => definition.id));
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
function jsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => jsonSafe(item, depth + 1));
  if (!record(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 128 && entries.every(([key, item]) => key.length > 0 && key.length <= 256 && jsonSafe(item, depth + 1));
}
function validCompetitorChannel(value: unknown): value is LmuResolvedValueWire {
  if (!record(value) || typeof value.semanticId !== "string" || value.semanticId.length > 256 || !TELEMETRY_SEMANTIC_IDS.has(value.semanticId) ||
      (typeof value.unit !== "string" && value.unit !== null) ||
      typeof value.state !== "string" || !STATES.includes(value.state) ||
      typeof value.mappingStatus !== "string" || !MAPPINGS.includes(value.mappingStatus) ||
      !["fresh", "stale", "unknown"].includes(String(value.freshness)) ||
      typeof value.schemaVersion !== "string" || !Array.isArray(value.limitations) ||
      value.limitations.length > 32 || !value.limitations.every((item) => typeof item === "string" && item.length <= 4096) ||
      (value.confidence !== null && !fraction(value.confidence)) || !record(value.confidenceComponents)) return false;
  const c = value.confidenceComponents;
  if (!fraction(c.semanticFidelity) || !fraction(c.inputCompleteness) || (c.freshness !== null && !fraction(c.freshness)) ||
      (c.derivationReliability !== undefined && !fraction(c.derivationReliability))) return false;
  if (value.state === "ok" ? value.value === null || !jsonSafe(value.value) : value.value !== null) return false;
  const p = value.provenance;
  if (!record(p) || p.simulator !== "lmu" || !timestamp(p.observedAt) ||
      !["parserId", "parserVersion", "resolverVersion", "catalogVersion", "catalogHash"].every((key) => typeof p[key] === "string" && (p[key] as string).length > 0)) return false;
  if ((p.sourceChannel !== undefined && typeof p.sourceChannel !== "string") || (p.sourceUnit !== undefined && typeof p.sourceUnit !== "string")) return false;
  if (p.derivation !== undefined && (!record(p.derivation) || !["id", "version", "codeHash"].every((key) => typeof (p.derivation as Record<string, unknown>)[key] === "string"))) return false;
  const source = p.sourceObservation;
  return source === undefined || record(source) && timestamp(source.timestamp) && typeof source.updateSequence === "string" && decimal.test(source.updateSequence);
}
function validCompetitor(value: unknown): value is LmuCompetitorWire {
  if (!record(value) || !Number.isSafeInteger(value.vehicleId) || (value.vehicleId as number) < 0 ||
      !Number.isSafeInteger(value.incarnation) || (value.incarnation as number) < 0 ||
      typeof value.isPlayer !== "boolean" || !record(value.channels)) return false;
  const channels = Object.entries(value.channels);
  return channels.length <= 256 && channels.every(([id, channel]) => record(channel) && id === channel.semanticId && validCompetitorChannel(channel));
}
function validContextKey(value: unknown): value is LmuLiveContextWire["key"] {
  return record(value) && typeof value.sessionKey === "string" && value.sessionKey.length > 0 &&
    value.sessionKey.length <= 2048 && typeof value.captureSequence === "string" &&
    decimal.test(value.captureSequence) && timestamp(value.frameTime);
}
export function decodeLmuContextKey(value: unknown): LmuLiveContext["key"] | null {
  return validContextKey(value) ? freezeOwned({ ...value, frameTime: decodeTimestamp(value.frameTime) }) : null;
}
export function isLmuLiveContextWire(value: unknown): value is LmuLiveContextWire {
  if (!record(value) || value.schemaVersion !== 1 || !validContextKey(value.key)) return false;
  const key = value.key;
  if (value.status !== "active" && value.status !== "unavailable") return false;
  if (value.playerVehicleId !== null && (typeof value.playerVehicleId !== "number" || !Number.isSafeInteger(value.playerVehicleId) || value.playerVehicleId < 0)) return false;
  if (value.status === "active" && value.playerVehicleId === null && value.competitors === undefined) return false;
  if (!Array.isArray(value.supplemental) || value.supplemental.length > Object.keys(LMU_REST_CHANNELS).length) return false;
  if (value.competitors !== undefined) {
    if (!Array.isArray(value.competitors) || value.competitors.length > 104) return false;
    const competitorIds = new Set<number>();
    let players = 0;
    for (const competitor of value.competitors) {
      if (!validCompetitor(competitor) || competitorIds.has(competitor.vehicleId)) return false;
      competitorIds.add(competitor.vehicleId);
      if (competitor.isPlayer) {
        players++;
        if (competitor.vehicleId !== value.playerVehicleId) return false;
      }
    }
    if (players > 1 || (value.playerVehicleId === null ? players !== 0 : players !== 1)) return false;
  }
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
export function encodeLmuResolvedValue<T>(value: ResolvedValue<T>): LmuResolvedValueWire<T> {
  const provenance = value.provenance;
  const { sourceObservation, ...rest } = provenance;
  return { ...value, provenance: { ...rest, observedAt: encodeTimestamp(provenance.observedAt), ...(sourceObservation ? { sourceObservation: { timestamp: encodeTimestamp(sourceObservation.timestamp), updateSequence: sourceObservation.updateSequence.toString() } } : {}) } };
}
function encodeCompetitor(value: LmuCompetitor): LmuCompetitorWire {
  const channels: Record<string, LmuResolvedValueWire> = {};
  for (const [id, channel] of Object.entries(value.channels)) channels[id] = encodeLmuResolvedValue(channel);
  return { ...value, channels };
}
function decodeCompetitor(value: LmuCompetitorWire): LmuCompetitor {
  const channels: Record<string, ResolvedValue<unknown>> = {};
  for (const [id, channel] of Object.entries(value.channels)) {
    const { sourceObservation, ...rest } = channel.provenance;
    channels[id] = { ...channel, provenance: { ...rest, observedAt: decodeTimestamp(channel.provenance.observedAt), ...(sourceObservation ? { sourceObservation: { timestamp: decodeTimestamp(sourceObservation.timestamp), updateSequence: BigInt(sourceObservation.updateSequence) } } : {}) } };
  }
  return { ...value, channels };
}
const immutableSupplemental = new WeakSet<readonly LmuSupplementalObservation[]>();
function freezeOwned<T>(value: T, seen = new WeakSet<object>()): T {
  if (value !== null && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const item of Object.values(value)) freezeOwned(item, seen);
    Object.freeze(value);
  }
  return value;
}
function encodeObservation(entry: LmuSupplementalObservation): LmuObservationWire {
  const p = entry.observation.provenance;
  const { sourceObservation, ...provenance } = p;
  return { ...entry, acquiredAt: encodeTimestamp(entry.acquiredAt), observation: { ...entry.observation, provenance: { ...provenance, observedAt: encodeTimestamp(p.observedAt), ...(sourceObservation ? { sourceObservation: { timestamp: encodeTimestamp(sourceObservation.timestamp), updateSequence: sourceObservation.updateSequence.toString() } } : {}) } } };
}
export function encodeLmuContext(value: LmuLiveContext): LmuLiveContextWire {
  const supplemental = value.supplemental.map(encodeObservation);
  const { competitors, ...context } = value;
  const wire: LmuLiveContextWire = { ...context, key: { ...value.key, frameTime: encodeTimestamp(value.key.frameTime) }, supplemental, ...(competitors ? { competitors: competitors.map(encodeCompetitor) } : {}) };
  if (!isLmuLiveContextWire(wire)) throw new TypeError("Invalid LMU live context");
  return wire;
}
/** Immutable mode consumes an owned decoded JSON tree; nested values are frozen, not copied. */
export function decodeLmuContext(value: unknown, options: { immutable?: boolean } = {}): LmuLiveContext | null {
  if (!isLmuLiveContextWire(value)) return null;
  const supplemental = value.supplemental.map((entry): LmuSupplementalObservation => {
    const p = entry.observation.provenance;
    const { sourceObservation, ...provenance } = p;
    return { ...entry, acquiredAt: decodeTimestamp(entry.acquiredAt), observation: { ...entry.observation, provenance: { ...provenance, observedAt: decodeTimestamp(p.observedAt), ...(sourceObservation ? { sourceObservation: { timestamp: decodeTimestamp(sourceObservation.timestamp), updateSequence: BigInt(sourceObservation.updateSequence) } } : {}) } } };
  });
  const { competitors, ...context } = value;
  const decoded: LmuLiveContext = { ...context, key: { ...value.key, frameTime: decodeTimestamp(value.key.frameTime) }, supplemental, ...(competitors ? { competitors: competitors.map(decodeCompetitor) } : {}) };
  if (options.immutable) {
    freezeOwned(decoded);
    immutableSupplemental.add(decoded.supplemental);
  }
  return decoded;
}

/** Cache only validated, deeply frozen supplemental arrays created by this module. */
export function createLmuContextEncoder(): (context: LmuLiveContext) => LmuLiveContextWire {
  const supplementalCache = new WeakMap<readonly LmuSupplementalObservation[], readonly LmuObservationWire[]>();
  return (value) => {
    if (!immutableSupplemental.has(value.supplemental)) return encodeLmuContext(value);
    let supplemental = supplementalCache.get(value.supplemental);
    if (!supplemental) {
      supplemental = freezeOwned(value.supplemental.map(encodeObservation));
      supplementalCache.set(value.supplemental, supplemental);
    }
    const { competitors, ...context } = value;
    const wire: LmuLiveContextWire = { ...context, key: { ...value.key, frameTime: encodeTimestamp(value.key.frameTime) }, supplemental, ...(competitors ? { competitors: competitors.map(encodeCompetitor) } : {}) };
    // Array contents are immutable and already validated; validate every changing boundary field.
    if (!isLmuLiveContextWire({ ...wire, supplemental: [] }) ||
        (supplemental.length > 0 && (supplemental[0]!.sessionKey !== wire.key.sessionKey ||
          supplemental.some((entry) => entry.applicability === "player-vehicle" && entry.vehicleId !== wire.playerVehicleId)))) {
      throw new TypeError("Invalid LMU live context");
    }
    return wire;
  };
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
