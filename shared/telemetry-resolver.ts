import { TELEMETRY_CATALOG, type TelemetryCatalogData, type TelemetryVariableDefinition } from "./telemetry-catalog";
import { getTelemetryDerivationForOutput, TELEMETRY_DERIVATION_VERSION, type DerivationContext, type DerivationResult, type MappingStatus, type TelemetryDerivation } from "./telemetry-derivations";
import type { GameId, TelemetryPacket } from "./types";

export { TELEMETRY_DERIVATION_VERSION } from "./telemetry-derivations";
export const TELEMETRY_RESOLVER_VERSION = "1.0.0";
export const TELEMETRY_PARSER_VERSIONS: Readonly<Record<GameId, string>> = {
  "fm-2023": "forza-udp@1", "f1-2025": "f1-2025-udp@1", acc: "acc-shared-memory@1.9",
  "ac-evo": "ac-evo-shared-memory@0.6", iracing: "iracing-source-frame@2",
};
export type SemanticSlot = number & { readonly __brand: "SemanticSlot" };
export type ResolutionState = "ok" | "missing" | "stale" | "invalid" | "not-applicable" | "error";
export interface ResolutionProvenance { simulator: GameId; parserId: string; parserVersion: string; sourceChannel?: string; sourceUnit?: string; resolverVersion: string; catalogVersion: string; catalogHash: string; derivation?: { id: string; version: string; codeHash: string }; observedAt: number; sourceTimestamp?: number }
export interface ConfidenceComponents { semanticFidelity: number; freshness: number; inputCompleteness: number; derivationReliability?: number }
export interface ResolvedValue<T> { semanticId: string; value: T | null; unit: string | null; mappingStatus: MappingStatus; state: ResolutionState; confidence: number; confidenceComponents: ConfidenceComponents; provenance: ResolutionProvenance; schemaVersion: string; limitations: readonly string[] }
export interface RequestedSemantic { semanticId: string; required?: boolean }
export interface ResolverCompileOptions { simulator: GameId; requested: readonly RequestedSemantic[]; rejectSimplified?: boolean; staleAfterMs?: Readonly<Record<string, number>>; parserId?: string; parserVersion?: string; derivations?: readonly TelemetryDerivation[] }
export interface TelemetryFrameView<NativeFrame = TelemetryPacket> { readonly __nativeFrameType?: NativeFrame; timestamp: number; has(slot: SemanticSlot): boolean; readValue<T>(slot: SemanticSlot): T | undefined; readNumber(slot: SemanticSlot): number | undefined; readBoolean(slot: SemanticSlot): boolean | undefined; resolveValue<T>(slot: SemanticSlot): ResolvedValue<T>; resolveNumber(slot: SemanticSlot): ResolvedValue<number>; resolveBoolean(slot: SemanticSlot): ResolvedValue<boolean>; resolveMany(slots: readonly SemanticSlot[], target?: ResolvedValue<unknown>[]): readonly ResolvedValue<unknown>[] }
export interface CompiledTelemetryResolver<NativeFrame = TelemetryPacket> { readonly catalogVersion: string; readonly catalogHash: string; readonly schemaVersion: string; readonly simulator: GameId; readonly parserVersion: string; readonly resolverVersion: string; readonly derivationVersion: string; slot(semanticId: string): SemanticSlot; createFrameView(native: NativeFrame, timestamp: number, reuse?: TelemetryFrameView<NativeFrame>): TelemetryFrameView<NativeFrame> }

type RuntimeCatalog = TelemetryCatalogData & { metadata?: { catalogVersion?: string; schemaVersion?: string; contentHash?: string } };
type NativeObject = Record<string, unknown>;
type Mapping = TelemetryVariableDefinition["games"][GameId];
type Reader = (frame: NativeObject) => unknown;
interface Plan { semanticId: string; variable: TelemetryVariableDefinition; mapping: Mapping; reader?: Reader; derivation?: TelemetryDerivation; executorError?: string; staleAfterMs: number }
const DEFAULT_STALE_MS = { continuous: 1_000, "pit-snapshot": 30_000, "session-update": 300_000, static: Number.POSITIVE_INFINITY } as const;
function sources(mapping: Exclude<Mapping, { kind: "unavailable" }>): readonly string[] { return Array.isArray(mapping.sources) ? mapping.sources : Object.values(mapping.sources).flat(); }
function readPath(value: unknown, path: readonly string[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as NativeObject)[key];
  }
  return value;
}
const INVALID_VALUE = Symbol("invalid telemetry value");
function packetField(frame: NativeObject, field: keyof TelemetryPacket): unknown {
  return frame[field] ??
    (frame.packet !== null && typeof frame.packet === "object"
      ? (frame.packet as NativeObject)[field]
      : undefined);
}
function cardinalityAccepts(
  count: number,
  cardinality: TelemetryVariableDefinition["cardinality"],
): boolean {
  return cardinality.kind === "scalar"
    ? count === 1
    : cardinality.kind === "fixed"
      ? count === cardinality.count
      : count >= cardinality.min &&
        (cardinality.max === undefined || count <= cardinality.max);
}

function primitiveAccepts(
  value: unknown,
  valueType: Exclude<
    TelemetryVariableDefinition["valueType"],
    "structured"
  >,
  enumDomain?: readonly string[],
): boolean {
  if (valueType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (valueType === "boolean") return typeof value === "boolean";
  if (valueType === "string") return typeof value === "string";
  return (
    typeof value === "string" &&
    (enumDomain === undefined || enumDomain.includes(value))
  );
}

function indexedLength(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (
    ArrayBuffer.isView(value) &&
    !(value instanceof DataView) &&
    "length" in value &&
    typeof value.length === "number"
  ) {
    return value.length;
  }
  return undefined;
}

function indexedValue(value: unknown, index: number): unknown {
  return value !== null && typeof value === "object"
    ? Reflect.get(value, String(index))
    : undefined;
}

function structuredValueAccepts(
  variable: TelemetryVariableDefinition,
  input: unknown,
): boolean {
  const schema = variable.structuredSchema;
  if (!schema) return input !== null && typeof input === "object";

  const validate = (value: unknown, depth: number): boolean => {
    if (depth < schema.indices.length) {
      const length = indexedLength(value);
      if (
        length === undefined ||
        !cardinalityAccepts(length, schema.indices[depth].cardinality)
      ) {
        return false;
      }
      for (let index = 0; index < length; index += 1) {
        if (!validate(indexedValue(value, index), depth + 1)) return false;
      }
      return true;
    }

    if (schema.fields.length === 1 && schema.fields[0].id === "value") {
      const field = schema.fields[0];
      let leaf = value;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "value" in value
      ) {
        leaf = value.value;
      }
      return primitiveAccepts(leaf, field.valueType, field.enumDomain);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    return schema.fields.every((field) =>
      primitiveAccepts(
        readPath(value, [field.id]),
        field.valueType,
        field.enumDomain,
      ),
    );
  };

  return validate(input, 0);
}

function canonicalEnum(
  input: unknown,
  domain?: readonly string[],
): string | typeof INVALID_VALUE {
  const value =
    typeof input === "string"
      ? input
      : typeof input === "number" && Number.isFinite(input)
        ? String(input)
        : undefined;
  return value !== undefined && (domain === undefined || domain.includes(value))
    ? value
    : INVALID_VALUE;
}

function canonicalValue(
  variable: TelemetryVariableDefinition,
  input: unknown,
): unknown | typeof INVALID_VALUE {
  const expectsCollection =
    variable.shape === "per-wheel" ||
    variable.shape === "vector" ||
    variable.shape === "array";
  if (expectsCollection && !Array.isArray(input)) return INVALID_VALUE;
  if (
    !expectsCollection &&
    variable.shape !== "structured" &&
    Array.isArray(input)
  ) {
    return INVALID_VALUE;
  }
  if (variable.shape === "structured") {
    return structuredValueAccepts(variable, input) ? input : INVALID_VALUE;
  }
  if (Array.isArray(input)) {
    if (
      !cardinalityAccepts(input.length, variable.cardinality) ||
      (variable.ordering !== undefined &&
        input.length !== variable.ordering.length)
    ) {
      return INVALID_VALUE;
    }
    for (let index = 0; index < input.length; index += 1) {
      const value = input[index];
      if (variable.valueType === "number") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return INVALID_VALUE;
        }
      } else if (variable.valueType === "boolean") {
        if (
          typeof value !== "boolean" &&
          (typeof value !== "number" || !Number.isFinite(value))
        ) {
          return INVALID_VALUE;
        }
        input[index] = typeof value === "boolean" ? value : value !== 0;
      } else if (variable.valueType === "string") {
        if (typeof value !== "string") return INVALID_VALUE;
      } else if (variable.valueType === "enum") {
        const canonical = canonicalEnum(value, variable.enumDomain);
        if (canonical === INVALID_VALUE) return INVALID_VALUE;
        input[index] = canonical;
      }
    }
    return input;
  }
  if (variable.valueType === "number") {
    return typeof input === "number" && Number.isFinite(input)
      ? input
      : INVALID_VALUE;
  }
  if (variable.valueType === "boolean") {
    if (typeof input === "boolean") return input;
    return typeof input === "number" && Number.isFinite(input)
      ? input !== 0
      : INVALID_VALUE;
  }
  if (variable.valueType === "string") {
    return typeof input === "string" ? input : INVALID_VALUE;
  }
  if (variable.valueType === "enum") {
    return canonicalEnum(input, variable.enumDomain);
  }
  return INVALID_VALUE;
}
function sourceValue(frame: NativeObject, source: string): unknown {
  const packet = frame.packet ?? frame;
  if (source.startsWith("TelemetryPacket.")) {
    return readPath(packet, source.slice(16).split("."));
  }
  const packetValue = readPath(packet, source.split("."));
  if (packetValue !== undefined) return packetValue;
  const nativeValues =
    frame.nativeValues !== null && typeof frame.nativeValues === "object"
      ? frame.nativeValues as NativeObject
      : undefined;
  if (!nativeValues) return undefined;
  const nativePath = source.split(".").slice(1);
  const flatKey = nativePath.join(".");
  return flatKey in nativeValues
    ? nativeValues[flatKey]
    : readPath(nativeValues, nativePath);
}

const WHEEL_SOURCE_KEY_ALIASES: Readonly<Record<string, string>> = {
  FL: "LF",
  FR: "RF",
  RL: "LR",
  RR: "RR",
};

function sourcesForOrderingKey(
  keyedSources: Record<string, readonly string[]>,
  key: string,
): readonly string[] | undefined {
  return (
    keyedSources[key] ??
    keyedSources[WHEEL_SOURCE_KEY_ALIASES[key]]
  );
}

function trustedNativeExecutor(
  variable: TelemetryVariableDefinition,
  mapping: Exclude<Mapping, { kind: "unavailable" }>,
): Reader | undefined {
  if (
    mapping.kind !== "normalized" ||
    mapping.execution?.kind !== "conversion"
  ) {
    return undefined;
  }

  const sourcePaths = sources(mapping);
  const nativeUnit = mapping.nativeUnit.trim().toLowerCase();
  if (variable.id === "fuel.fuel-percent" && nativeUnit === "fraction") {
    return (frame) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value)) {
          return value * 100;
        }
      }
      return undefined;
    };
  }
  if (variable.id === "timing.lap-fraction" && nativeUnit === "fraction") {
    return (frame) => {
      for (const source of sourcePaths) {
        const value = sourceValue(frame, source);
        if (typeof value === "number" && Number.isFinite(value)) {
          return Math.max(0, Math.min(1, value));
        }
      }
      return undefined;
    };
  }
  if (variable.id !== "timing.track-length") return undefined;

  const multiplier = nativeUnit === "km" ? 1_000 : nativeUnit === "m" ? 1 : undefined;
  if (multiplier === undefined) return undefined;

  return (frame) => {
    for (const source of sourcePaths) {
      const value = sourceValue(frame, source);
      if (typeof value === "number" && Number.isFinite(value)) {
        return value * multiplier;
      }
      if (typeof value !== "string") continue;
      const match = value.trim().match(
        /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(km|m)$/i,
      );
      if (!match) continue;
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) continue;
      return amount * (match[2].toLowerCase() === "km" ? 1_000 : 1);
    }
    return undefined;
  };
}

function readerFor(
  variable: TelemetryVariableDefinition,
  mapping: Exclude<Mapping, { kind: "unavailable" }>,
): Reader | undefined {
  const fields = variable.packetFields;
  const keyedSources: Record<string, readonly string[]> | undefined =
    Array.isArray(mapping.sources)
      ? undefined
      : mapping.sources as Record<string, readonly string[]>;
  const keyedCollection =
    keyedSources !== undefined && variable.shape !== "structured";
  const ordering = keyedCollection
    ? variable.ordering ?? Object.keys(keyedSources)
    : undefined;
  if ((fields && fields.length > 1) || keyedCollection) {
    const count = Math.max(fields?.length ?? 0, ordering?.length ?? 0);
    const values = new Array<unknown>(count);
    return (frame) => {
      let available = 0;
      for (let index = 0; index < count; index += 1) {
        let value =
          fields && index < fields.length
            ? packetField(frame, fields[index])
            : undefined;
        if (
          value === undefined &&
          mapping.kind !== "normalized" &&
          keyedSources &&
          ordering
        ) {
          for (const source of
            sourcesForOrderingKey(keyedSources, ordering[index]) ?? []) {
            value = sourceValue(frame, source);
            if (value !== undefined) break;
          }
        }
        values[index] = value;
        if (value !== undefined) available += 1;
      }
      return available === 0 ? undefined : values;
    };
  }
  const field = fields?.[0];
  const sourcePaths = sources(mapping);
  return (frame) => {
    if (field) {
      const value = packetField(frame, field);
      if (value !== undefined) return value;
      if (mapping.kind === "normalized") return undefined;
    }
    for (const source of sourcePaths) {
      const value = sourceValue(frame, source);
      if (value !== undefined) return value;
    }
    return undefined;
  };
}

class FrameView<NativeFrame> implements TelemetryFrameView<NativeFrame> {
  timestamp = 0;
  private native!: NativeObject;
  private generation = 0;
  private readonly generations: Uint32Array;
  private readonly states: Uint8Array;
  private readonly values: unknown[];
  private readonly reusableDerivationResult: {
    state: "ok" | "missing";
    value?: unknown;
    reason?: string;
  } = { state: "missing" };
  private readonly dependencyStates: Uint8Array;
  private derivationDepth = 0;
  private readonly derivationContext: DerivationContext;
  readonly resolver: Resolver<NativeFrame>;

  constructor(resolver: Resolver<NativeFrame>, count: number) {
    this.resolver = resolver;
    this.generations = new Uint32Array(count);
    this.states = new Uint8Array(count);
    this.values = new Array(count);
    this.dependencyStates = new Uint8Array(count + 1);
    this.derivationContext = {
      number: (id) => this.derivationNumber(id),
      boolean: (id) => this.derivationBoolean(id),
      text: (id) => this.derivationText(id),
      unavailable: (reason) => {
        this.reusableDerivationResult.state = "missing";
        this.reusableDerivationResult.value = undefined;
        this.reusableDerivationResult.reason = reason;
        return this.reusableDerivationResult as DerivationResult;
      },
      value: <T>(value: T) => {
        this.reusableDerivationResult.state = "ok";
        this.reusableDerivationResult.value = value;
        this.reusableDerivationResult.reason = undefined;
        return this.reusableDerivationResult as DerivationResult<T>;
      },
    };
  }

  private dependencyCode(slot: SemanticSlot): number {
    this.evaluate(slot);
    const state =
      this.states[slot] === 1 && !this.isFresh(slot) ? 6 : this.states[slot];
    if (state !== 1) {
      const current = this.dependencyStates[this.derivationDepth];
      const priority =
        state === 5
          ? 5
          : state === 3
            ? 4
            : state === 4
              ? 3
              : state === 6
                ? 2
                : 1;
      const currentPriority =
        current === 5
          ? 5
          : current === 3
            ? 4
            : current === 4
              ? 3
              : current === 6
                ? 2
                : current === 2
                  ? 1
                  : 0;
      if (priority > currentPriority) {
        this.dependencyStates[this.derivationDepth] = state;
      }
    }
    return state;
  }

  private derivationNumber(id: string): number | undefined {
    const slot = this.resolver.slot(id);
    if (this.dependencyCode(slot) !== 1) return undefined;
    const value = this.values[slot];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  private derivationBoolean(id: string): boolean | undefined {
    const slot = this.resolver.slot(id);
    if (this.dependencyCode(slot) !== 1) return undefined;
    const value = this.values[slot];
    return typeof value === "boolean" ? value : undefined;
  }

  private derivationText(id: string): string | undefined {
    const slot = this.resolver.slot(id);
    if (this.dependencyCode(slot) !== 1) return undefined;
    const value = this.values[slot];
    return typeof value === "string" ? value : undefined;
  }
  reset(native: NativeFrame, timestamp: number): this { this.native = native as unknown as NativeObject; this.timestamp = timestamp; this.generation += 1; if (this.generation === 0) { this.generations.fill(0); this.generation = 1; } return this; }
  has(slot: SemanticSlot): boolean { this.evaluate(slot); return this.states[slot] === 1 && this.isFresh(slot); }
  readValue<T>(slot: SemanticSlot): T | undefined {
    this.evaluate(slot);
    return this.states[slot] === 1 && this.isFresh(slot)
      ? this.values[slot] as T
      : undefined;
  }
  readNumber(slot: SemanticSlot): number | undefined { this.evaluate(slot); const value = this.values[slot]; return this.states[slot] === 1 && this.isFresh(slot) && typeof value === "number" && Number.isFinite(value) ? value : undefined; }
  readBoolean(slot: SemanticSlot): boolean | undefined { this.evaluate(slot); const value = this.values[slot]; if (this.states[slot] !== 1 || !this.isFresh(slot)) return undefined; return typeof value === "boolean" ? value : typeof value === "number" && Number.isFinite(value) ? value !== 0 : undefined; }
  resolveValue<T>(slot: SemanticSlot): ResolvedValue<T> {
    return this.resolve(slot) as ResolvedValue<T>;
  }
  resolveNumber(slot: SemanticSlot): ResolvedValue<number> { return this.resolve(slot, "number") as ResolvedValue<number>; }
  resolveBoolean(slot: SemanticSlot): ResolvedValue<boolean> { return this.resolve(slot, "boolean") as ResolvedValue<boolean>; }
  resolveMany(slots: readonly SemanticSlot[], target: ResolvedValue<unknown>[] = []): readonly ResolvedValue<unknown>[] { target.length = slots.length; for (let i = 0; i < slots.length; i += 1) target[i] = this.resolve(slots[i]); return target; }
  private evaluate(slot: SemanticSlot): void {
    if (slot < 0 || slot >= this.resolver.plans.length) throw new RangeError(`Unknown semantic slot ${slot}`); if (this.generations[slot] === this.generation) return; this.generations[slot] = this.generation;
    const plan = this.resolver.plans[slot];
    try {
      if (plan.executorError) {
        this.values[slot] = undefined;
        this.states[slot] = 5;
        return;
      }
      if (plan.derivation) {
        this.derivationDepth += 1;
        this.dependencyStates[this.derivationDepth] = 1;
        let result: DerivationResult;
        let dependencyState: number;
        try {
          result = plan.derivation.evaluate(this.derivationContext);
        } finally {
          dependencyState = this.dependencyStates[this.derivationDepth];
          this.derivationDepth -= 1;
        }
        if (result.state === "ok") {
          const value = canonicalValue(plan.variable, result.value);
          if (value === INVALID_VALUE) {
            this.values[slot] = undefined;
            this.states[slot] = 3;
          } else {
            this.values[slot] = value;
            this.states[slot] = 1;
          }
        } else {
          this.values[slot] = undefined;
          this.states[slot] =
            dependencyState !== 1
              ? dependencyState
              : result.state === "invalid"
                ? 3
                : result.state === "error"
                  ? 5
                  : result.state === "not-applicable"
                    ? 4
                    : 2;
        }
        return;
      }
      const input = plan.reader?.(this.native);
      if (input === undefined || input === null) {
        this.values[slot] = undefined;
        this.states[slot] =
          plan.mapping.kind === "unavailable" &&
          plan.mapping.reason === "not-applicable"
            ? 4
            : 2;
      } else {
        const value = canonicalValue(plan.variable, input);
        if (value === INVALID_VALUE) {
          this.values[slot] = undefined;
          this.states[slot] = 3;
        } else {
          this.values[slot] = value;
          this.states[slot] = 1;
        }
      }
    } catch { this.values[slot] = undefined; this.states[slot] = 5; }
  }
  private sourceTimestamp(): number | undefined {
    const direct = this.native.TimestampMS;
    if (typeof direct === "number") return direct;
    const packet = this.native.packet;
    if (packet !== null && typeof packet === "object") {
      const nested = (packet as NativeObject).TimestampMS;
      if (typeof nested === "number") return nested;
    }
    return undefined;
  }
  private isFresh(slot: SemanticSlot): boolean {
    const threshold = this.resolver.plans[slot].staleAfterMs;
    const timestamp = this.sourceTimestamp();
    return !Number.isFinite(threshold) || timestamp === undefined || Math.max(0, this.timestamp - timestamp) <= threshold;
  }
  private resolve(slot: SemanticSlot, expected?: "number" | "boolean"): ResolvedValue<unknown> {
    this.evaluate(slot); const plan = this.resolver.plans[slot]; let value: unknown = this.states[slot] === 1 ? this.values[slot] : null;
    let state: ResolutionState = this.states[slot] === 1 ? "ok" : this.states[slot] === 2 ? "missing" : this.states[slot] === 3 ? "invalid" : this.states[slot] === 4 ? "not-applicable" : this.states[slot] === 6 ? "stale" : "error";
    if (expected === "number" && typeof value !== "number") { value = null; if (state === "ok") state = "invalid"; }
    if (expected === "boolean") { if (typeof value === "number" && Number.isFinite(value)) value = value !== 0; else if (typeof value !== "boolean") { value = null; if (state === "ok") state = "invalid"; } }
    const mappingStatus = plan.mapping.kind; const fidelity = mappingStatus === "direct" ? 1 : mappingStatus === "normalized" ? 0.99 : mappingStatus === "derived" ? 0.95 : mappingStatus === "simplified" ? 0.7 : 0;
    const timestamp = this.sourceTimestamp(); const freshness = this.states[slot] === 6 ? 0 : this.isFresh(slot) ? 1 : 0; if (state === "ok" && freshness === 0) state = "stale"; const completeness = state === "ok" || (state === "stale" && value !== null) ? 1 : 0;
    const source = plan.mapping.kind === "unavailable" ? undefined : sources(plan.mapping)[0];
    return { semanticId: plan.semanticId, value, unit: plan.mapping.kind === "unavailable" ? null : plan.variable.canonicalUnit, mappingStatus, state, confidence: fidelity * freshness * completeness, confidenceComponents: { semanticFidelity: fidelity, freshness, inputCompleteness: completeness, ...(plan.derivation ? { derivationReliability: plan.derivation.deterministic ? 1 : 0.8 } : {}) }, provenance: { simulator: this.resolver.simulator, parserId: this.resolver.parserId, parserVersion: this.resolver.parserVersion, ...(source && plan.mapping.kind !== "unavailable" ? { sourceChannel: source, sourceUnit: plan.mapping.nativeUnit } : {}), resolverVersion: TELEMETRY_RESOLVER_VERSION, catalogVersion: this.resolver.catalogVersion, catalogHash: this.resolver.catalogHash, ...(plan.derivation ? { derivation: { id: plan.derivation.id, version: plan.derivation.version, codeHash: plan.derivation.codeHash } } : {}), observedAt: this.timestamp, sourceTimestamp: typeof timestamp === "number" ? timestamp : undefined }, schemaVersion: this.resolver.schemaVersion, limitations: plan.mapping.kind === "unavailable" ? [plan.mapping.description] : plan.executorError ? [...plan.mapping.limitations, plan.executorError] : plan.mapping.limitations };
  }
}

class Resolver<NativeFrame> implements CompiledTelemetryResolver<NativeFrame> {
  readonly plans: readonly Plan[]; readonly catalogVersion: string; readonly catalogHash: string; readonly schemaVersion: string; readonly simulator: GameId; readonly parserId: string; readonly parserVersion: string; readonly resolverVersion = TELEMETRY_RESOLVER_VERSION; readonly derivationVersion = TELEMETRY_DERIVATION_VERSION; private readonly slots = new Map<string, SemanticSlot>();
  constructor(catalog: TelemetryCatalogData, options: ResolverCompileOptions) {
    const metadata = (catalog as RuntimeCatalog).metadata; this.catalogVersion = metadata?.catalogVersion ?? catalog.format; this.catalogHash = metadata?.contentHash ?? "unversioned-catalog"; this.schemaVersion = metadata?.schemaVersion ?? catalog.format; this.simulator = options.simulator; this.parserId = options.parserId ?? options.simulator; this.parserVersion = options.parserVersion ?? TELEMETRY_PARSER_VERSIONS[options.simulator];
    const variables = new Map(catalog.variables.map((variable) => [variable.id, variable])); const custom = new Map((options.derivations ?? []).map((definition) => [definition.output.semanticId, definition])); const visiting = new Set<string>(); const ordered = new Set<string>();
    const derivationFor = (
      id: string,
      mapping: Mapping,
    ): TelemetryDerivation | undefined =>
      mapping.kind === "derived"
        ? custom.get(id) ?? getTelemetryDerivationForOutput(id)
        : undefined;
    const visit = (id: string): void => {
      if (ordered.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Telemetry derivation cycle at ${id}`);
      }
      visiting.add(id);
      const variable = variables.get(id);
      if (!variable) throw new Error(`Unknown telemetry semantic ${id}`);
      const mapping = variable.games[options.simulator];
      if (!mapping) throw new Error(`${id} missing ${options.simulator} mapping`);
      const derivation = derivationFor(id, mapping);
      if (derivation) {
        for (const input of derivation.inputs) visit(input.semanticId);
      }
      visiting.delete(id);
      ordered.add(id);
    };
    for (const request of options.requested) visit(request.semanticId);
    this.plans = [...ordered].map((id, index) => {
      const variable = variables.get(id)!;
      const mapping = variable.games[options.simulator];
      if (mapping.kind === "simplified" && options.rejectSimplified) {
        throw new Error(`Simplified telemetry mapping rejected for ${id}`);
      }
      const derivation = derivationFor(id, mapping);
      const nativeExecutor =
        mapping.kind === "unavailable"
          ? undefined
          : trustedNativeExecutor(variable, mapping);
      const unsupportedExecution =
        mapping.kind === "normalized" &&
        mapping.execution?.kind !== "conversion";
      const unavailableExecutor =
        (mapping.kind === "normalized" ||
          mapping.kind === "derived" ||
          mapping.kind === "simplified") &&
        !variable.packetFields?.length &&
        derivation === undefined &&
        nativeExecutor === undefined;
      const executorError =
        unsupportedExecution || unavailableExecutor
          ? `unsupported-${mapping.kind}-executor:${options.simulator}:${id}`
          : undefined;
      const reader =
        mapping.kind === "unavailable" ||
        executorError !== undefined ||
        derivation !== undefined
          ? undefined
          : nativeExecutor ?? readerFor(variable, mapping);
      if (
        options.requested.some(
          (request) => request.semanticId === id && request.required,
        ) &&
        mapping.kind === "unavailable" &&
        !derivation
      ) {
        throw new Error(
          `Required telemetry semantic unavailable: ${id} for ${options.simulator}`,
        );
      }
      this.slots.set(id, index as SemanticSlot);
      return {
        semanticId: id,
        variable,
        mapping,
        reader,
        derivation,
        executorError,
        staleAfterMs:
          options.staleAfterMs?.[id] ??
          (mapping.kind === "unavailable"
            ? Number.POSITIVE_INFINITY
            : DEFAULT_STALE_MS[mapping.freshness]),
      };
    });
  }
  slot(id: string): SemanticSlot { const slot = this.slots.get(id); if (slot === undefined) throw new Error(`Telemetry semantic not compiled: ${id}`); return slot; }
  createFrameView(native: NativeFrame, timestamp: number, reuse?: TelemetryFrameView<NativeFrame>): TelemetryFrameView<NativeFrame> { const view = reuse instanceof FrameView && reuse.resolver === this ? reuse : new FrameView(this, this.plans.length); return view.reset(native, timestamp); }
}

export function compileTelemetryResolver<NativeFrame = TelemetryPacket>(
  options: ResolverCompileOptions,
): CompiledTelemetryResolver<NativeFrame>;
export function compileTelemetryResolver<NativeFrame = TelemetryPacket>(
  catalog: TelemetryCatalogData,
  options: ResolverCompileOptions,
): CompiledTelemetryResolver<NativeFrame>;
export function compileTelemetryResolver<NativeFrame = TelemetryPacket>(
  catalogOrOptions: TelemetryCatalogData | ResolverCompileOptions,
  maybeOptions?: ResolverCompileOptions,
): CompiledTelemetryResolver<NativeFrame> {
  const catalog = maybeOptions ? (catalogOrOptions as TelemetryCatalogData) : TELEMETRY_CATALOG;
  const options = maybeOptions ?? (catalogOrOptions as ResolverCompileOptions);
  return new Resolver<NativeFrame>(catalog, options);
}
