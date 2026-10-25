import { isLmuLiveContextWire, type LmuLiveContextWire, type LmuObservationWire } from "@raceiq/shared/telemetry/lmu-context";
import type { SemanticLapTelemetry, SemanticReplayFrame } from "./replay";

export const SEMANTIC_REPLAY_MEDIA_TYPE = "application/vnd.raceiq.semantic-replay+json";
const FORMAT = "raceiq-semantic-replay-v1";
type ValueDefinition = Omit<SemanticReplayFrame["values"][number], "value">;
type CompactContext = Omit<LmuLiveContextWire, "supplemental"> & { supplemental: number[] };
type CompactFrame = Omit<SemanticReplayFrame, "values" | "lmu"> & {
  values: Array<[definitionIndex: number, value: unknown]>;
  lmu?: CompactContext;
};
export type CompactSemanticLapTelemetry = Omit<SemanticLapTelemetry, "envelopes"> & {
  format: typeof FORMAT;
  definitions: ValueDefinition[];
  supplemental: LmuObservationWire[];
  envelopes: CompactFrame[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Object key order is not part of observation identity; every field and timestamp is.
function contentKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(contentKey).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${contentKey(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function createSemanticReplayEncoder(): {
  addFrame(frame: SemanticReplayFrame): void;
  finish(metadata: Omit<SemanticLapTelemetry, "envelopes">): CompactSemanticLapTelemetry;
} {
  const definitions: ValueDefinition[] = [];
  const supplemental: LmuObservationWire[] = [];
  const envelopes: CompactFrame[] = [];
  const definitionKeys = new Map<string, number>();
  const observationKeys = new Map<string, number>();
  const previousDefinitions: number[] = [];
  const observationReferences = new WeakMap<LmuObservationWire, number>();

  function definitionIndex(entry: SemanticReplayFrame["values"][number], position: number): number {
    const cached = previousDefinitions[position];
    const previous = cached === undefined ? undefined : definitions[cached];
    if (previous && previous.semanticId === entry.semanticId && previous.unit === entry.unit &&
        previous.state === entry.state && previous.freshness === entry.freshness) return cached!;
    const { value: _value, ...definition } = entry;
    const key = contentKey(definition);
    let index = definitionKeys.get(key);
    if (index === undefined) {
      index = definitions.length;
      definitions.push(definition);
      definitionKeys.set(key, index);
    }
    previousDefinitions[position] = index;
    return index;
  }

  function observationIndex(observation: LmuObservationWire): number {
    const cached = observationReferences.get(observation);
    if (cached !== undefined) return cached;
    const key = contentKey(observation);
    let index = observationKeys.get(key);
    if (index === undefined) {
      index = supplemental.length;
      supplemental.push(observation);
      observationKeys.set(key, index);
    }
    observationReferences.set(observation, index);
    return index;
  }

  return {
    addFrame(frame) {
      const { values, lmu, ...metadata } = frame;
      envelopes.push({
        ...metadata,
        values: values.map((entry, position) => [definitionIndex(entry, position), entry.value]),
        ...(lmu === undefined ? {} : { lmu: { ...lmu, supplemental: lmu.supplemental.map(observationIndex) } }),
      });
    },
    finish(metadata) {
      return { ...metadata, format: FORMAT, definitions, supplemental, envelopes };
    },
  };
}

export function packSemanticLapTelemetry(value: SemanticLapTelemetry): CompactSemanticLapTelemetry {
  const encoder = createSemanticReplayEncoder();
  for (const frame of value.envelopes) encoder.addFrame(frame);
  const { envelopes: _envelopes, ...metadata } = value;
  return encoder.finish(metadata);
}

function invalid(): never {
  throw new TypeError("Invalid semantic replay telemetry");
}

function definition(value: unknown): value is ValueDefinition {
  return record(value) && typeof value.semanticId === "string" &&
    (value.unit === undefined || value.unit === null || typeof value.unit === "string") &&
    (value.state === undefined || typeof value.state === "string") &&
    (value.freshness === undefined || typeof value.freshness === "string");
}

function timestamp(value: unknown): boolean {
  return record(value) && typeof value.domain === "string" && typeof value.milliseconds === "number" && Number.isFinite(value.milliseconds);
}

function frameMetadata(value: unknown): value is Record<string, unknown> & Pick<SemanticReplayFrame, "sequence" | "observedAt" | "receivedAt" | "simulator"> {
  return record(value) && Number.isSafeInteger(value.sequence) && timestamp(value.observedAt) && timestamp(value.receivedAt) && typeof value.simulator === "string";
}

function lapMetadata(value: Record<string, unknown>): boolean {
  const numbers = (items: unknown) => items === undefined || items === null || Array.isArray(items) && items.every((item) => typeof item === "number" && Number.isFinite(item));
  return Number.isSafeInteger(value.lapId) && Array.isArray(value.requestedSemanticIds) && value.requestedSemanticIds.every((id) => typeof id === "string") &&
    numbers(value.sectorTimes) && numbers(value.sectorStarts) &&
    (value.insights === undefined || Array.isArray(value.insights)) &&
    (value.detectorCoverage === undefined || Array.isArray(value.detectorCoverage)) &&
    (value.parseError === undefined || value.parseError === null || typeof value.parseError === "string");
}

function jsonValue(value: unknown, validated: WeakSet<object>, visiting: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (validated.has(value)) return true;
  if (visiting.has(value)) return false;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  visiting.add(value);
  for (const entry of array ? value : Object.values(value)) {
    if (!jsonValue(entry, validated, visiting)) return false;
  }
  visiting.delete(value);
  validated.add(value);
  return true;
}

function observation(value: unknown): value is LmuObservationWire {
  if (!record(value)) return false;
  // Reuse the authoritative observation validator once per dictionary entry.
  return isLmuLiveContextWire({
    schemaVersion: 1,
    key: { sessionKey: value.sessionKey, captureSequence: "0", frameTime: value.acquiredAt },
    status: "unavailable",
    playerVehicleId: value.applicability === "player-vehicle" ? value.vehicleId : null,
    supplemental: [value],
  });
}

function dictionaryIndex(value: unknown, length: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= length) invalid();
  return value;
}

function decodeContext(value: unknown, supplemental: readonly LmuObservationWire[]): LmuLiveContextWire {
  if (!record(value) || !Array.isArray(value.supplemental)) throw new TypeError("Invalid LMU historical context");
  const { supplemental: indices, ...metadata } = value;
  // Validate frame-local keys and competitors without rescanning dictionary payloads.
  const context = { ...metadata, supplemental: [] };
  if (!isLmuLiveContextWire(context)) throw new TypeError("Invalid LMU historical context");
  const ids = new Set<string>();
  const observations: LmuObservationWire[] = [];
  for (const index of indices) {
    const entry = supplemental[dictionaryIndex(index, supplemental.length)]!;
    if (entry.sessionKey !== context.key.sessionKey ||
        (entry.applicability === "player-vehicle" && entry.vehicleId !== context.playerVehicleId) || ids.has(entry.semanticId)) {
      throw new TypeError("Invalid LMU historical context");
    }
    ids.add(entry.semanticId);
    observations.push(entry);
  }
  return { ...context, supplemental: observations };
}

/** Decode the negotiated wire representation into the unchanged replay consumer model. */
export function decodeSemanticLapTelemetry(value: unknown): SemanticLapTelemetry {
  if (!record(value) || !lapMetadata(value) || !Array.isArray(value.envelopes)) invalid();
  const validated = new WeakSet<object>();
  const visiting = new WeakSet<object>();
  if (!Object.hasOwn(value, "format")) {
    for (const frame of value.envelopes) {
      if (!frameMetadata(frame) || !Array.isArray(frame.values)) invalid();
      for (const entry of frame.values) {
        if (!record(entry) || !Object.hasOwn(entry, "value") || !jsonValue(entry.value, validated, visiting) || !definition(entry)) invalid();
      }
      if (frame.lmu !== undefined && !isLmuLiveContextWire(frame.lmu)) throw new TypeError("Invalid LMU historical context");
    }
    return value as unknown as SemanticLapTelemetry;
  }
  if (value.format !== FORMAT || !Array.isArray(value.definitions) || !Array.isArray(value.supplemental)) invalid();
  const definitions: ValueDefinition[] = value.definitions;
  for (const entry of definitions) {
    if (!definition(entry) || Object.hasOwn(entry, "value")) invalid();
  }
  const supplemental: LmuObservationWire[] = value.supplemental;
  for (const entry of supplemental) {
    if (!observation(entry)) throw new TypeError("Invalid LMU historical context");
  }
  const envelopes: SemanticReplayFrame[] = [];
  for (const frame of value.envelopes) {
    if (!frameMetadata(frame) || !Array.isArray(frame.values)) invalid();
    const { values, lmu, ...metadata } = frame;
    const expanded: SemanticReplayFrame["values"] = [];
    for (const entry of values) {
      if (!Array.isArray(entry) || entry.length !== 2 || !jsonValue(entry[1], validated, visiting)) invalid();
      const index = dictionaryIndex(entry[0], definitions.length);
      expanded.push({ ...definitions[index]!, value: entry[1] });
    }
    envelopes.push({ ...metadata, values: expanded, ...(lmu === undefined ? {} : { lmu: decodeContext(lmu, supplemental) }) });
  }
  const { format: _format, definitions: _definitions, supplemental: _supplemental, envelopes: _envelopes, ...metadata } = value;
  return { ...metadata, envelopes } as SemanticLapTelemetry;
}
