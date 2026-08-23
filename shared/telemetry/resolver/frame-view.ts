import type { DerivationContext, DerivationResult } from "../derivations/contracts";
import type { FreshnessState, ResolutionState, ResolvedValue, SemanticSlot, SourceObservation, TelemetryFrameView, TelemetryTimestamp } from "./contracts";
import type { NativeObject, ReaderContext, RuntimeResolver, SourceFreshness } from "./plan";
import { canonicalValue, INVALID_VALUE, sources } from "./value";
import { TELEMETRY_RESOLVER_VERSION } from "./versions";

type ObservationDomain = TelemetryTimestamp["domain"] | "mixed";

interface SourceState {
  value: unknown;
  observation: SourceObservation;
}

function sourceValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sourceValuesEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftRecord = left as NativeObject;
  const rightRecord = right as NativeObject;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(rightRecord, key) || !sourceValuesEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

function cloneSourceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSourceValue);
  if (value === null || typeof value !== "object") return value;
  const clone: NativeObject = {};
  for (const [key, child] of Object.entries(value as NativeObject)) {
    clone[key] = cloneSourceValue(child);
  }
  return clone;
}

function ageMilliseconds(current: TelemetryTimestamp, source: TelemetryTimestamp): number | undefined {
  if (current.domain !== source.domain) return undefined;
  if (current.domain === "monotonic" && source.domain === "monotonic") {
    const age = current.nanoseconds - source.nanoseconds;
    return age < 0n ? undefined : Number(age) / 1_000_000;
  }
  if (current.domain === "monotonic" || source.domain === "monotonic") {
    return undefined;
  }
  if (!Number.isFinite(current.milliseconds) || !Number.isFinite(source.milliseconds)) {
    return undefined;
  }
  const age = current.milliseconds - source.milliseconds;
  return age < 0 ? undefined : age;
}

export class FrameView<NativeFrame> implements TelemetryFrameView<NativeFrame> {
  observation: SourceObservation = {
    timestamp: { domain: "session", milliseconds: 0 },
    updateSequence: 0n,
  };
  private native!: NativeObject;
  private generation = 0;
  private readonly generations: Uint32Array;
  private readonly states: Uint8Array;
  private readonly values: unknown[];
  private readonly observations: Array<SourceObservation | undefined>;
  private readonly observationDomains: Array<ObservationDomain | undefined>;
  private readonly sourceChannels: Array<string | undefined>;
  private readonly sourceStates = new Map<string, SourceState>();
  private readonly reusableDerivationResult: {
    state: "ok" | "missing";
    value?: unknown;
    reason?: string;
  } = { state: "missing" };
  private readonly dependencyStates: Uint8Array;
  private readonly dependencyObservations: Array<SourceObservation | undefined>;
  private readonly dependencyDomains: Array<ObservationDomain | undefined>;
  private derivationDepth = 0;
  private readonly derivationContext: DerivationContext;
  private readonly readerContext: ReaderContext = {
    observe: (sourceChannel, value, freshness) => this.observeSource(sourceChannel, value, freshness),
  };
  readonly resolver: RuntimeResolver;

  constructor(resolver: RuntimeResolver, count: number) {
    this.resolver = resolver;
    this.generations = new Uint32Array(count);
    this.states = new Uint8Array(count);
    this.values = new Array(count);
    this.observations = new Array(count);
    this.observationDomains = new Array(count);
    this.sourceChannels = new Array(count);
    this.dependencyStates = new Uint8Array(count + 1);
    this.dependencyObservations = new Array(count + 1);
    this.dependencyDomains = new Array(count + 1);
    this.derivationContext = {
      number: (id) => this.derivationNumber(id),
      boolean: (id) => this.derivationBoolean(id),
      text: (id) => this.derivationText(id),
      structured: <T>(id: string) => this.derivationStructured<T>(id),
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
  resetSourceState(): void {
    this.sourceStates.clear();
  }


  private observeSource(sourceChannel: string, value: unknown, freshness: SourceFreshness): SourceObservation {
    if (freshness === "continuous") return this.observation;
    const key = `${freshness}:${sourceChannel}`;
    const previous = this.sourceStates.get(key);
    if (previous && sourceValuesEqual(previous.value, value)) {
      return previous.observation;
    }
    this.sourceStates.set(key, {
      value: cloneSourceValue(value),
      observation: this.observation,
    });
    return this.observation;
  }

  private dependencyCode(slot: SemanticSlot): number {
    this.evaluate(slot);
    const state = this.states[slot] === 1 && this.freshnessState(slot) === "stale" ? 6 : this.states[slot];
    const depth = this.derivationDepth;
    const observation = this.observations[slot];
    const domain = this.observationDomains[slot];
    if (observation !== undefined) {
      const current = this.dependencyObservations[depth];
      if (current === undefined || observation.updateSequence > current.updateSequence) {
        this.dependencyObservations[depth] = observation;
      }
    }
    if (domain !== undefined) {
      const currentDomain = this.dependencyDomains[depth];
      this.dependencyDomains[depth] = currentDomain === undefined || currentDomain === domain ? domain : "mixed";
    }
    if (state !== 1) {
      const current = this.dependencyStates[depth];
      const priority = state === 5 ? 5 : state === 3 ? 4 : state === 4 ? 3 : state === 6 ? 2 : 1;
      const currentPriority = current === 5 ? 5 : current === 3 ? 4 : current === 4 ? 3 : current === 6 ? 2 : current === 2 ? 1 : 0;
      if (priority > currentPriority) {
        this.dependencyStates[depth] = state;
      }
    }
    return state;
  }

  private derivationNumber(id: string): number | undefined {
    const slot = this.resolver.slot(id);
    if (this.dependencyCode(slot) !== 1) return undefined;
    const value = this.values[slot];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

  private derivationStructured<T>(id: string): T | undefined {
    const slot = this.resolver.slot(id);
    return this.dependencyCode(slot) === 1 ? this.values[slot] as T : undefined;
  }

  reset(native: NativeFrame, observation: SourceObservation): this {
    this.native = native as unknown as NativeObject;
    this.observation = observation;
    this.generation += 1;
    if (this.generation === 0) {
      this.generations.fill(0);
      this.generation = 1;
    }
    return this;
  }
  resolutionState(slot: SemanticSlot): ResolutionState {
    this.evaluate(slot);
    if (this.states[slot] === 1) {
      return this.freshnessState(slot) === "stale" ? "stale" : "ok";
    }
    return this.states[slot] === 2
      ? "missing"
      : this.states[slot] === 3
        ? "invalid"
        : this.states[slot] === 4
          ? "not-applicable"
          : this.states[slot] === 6
            ? "stale"
            : "error";
  }

  sourceFreshness(
    slot: SemanticSlot,
  ): ResolvedValue<unknown>["sourceFreshness"] {
    this.evaluate(slot);
    const mapping = this.resolver.plans[slot].mapping;
    return mapping.kind === "unavailable" ? null : mapping.freshness;
  }


  has(slot: SemanticSlot): boolean {
    this.evaluate(slot);
    return this.states[slot] === 1 && this.freshnessState(slot) !== "stale";
  }

  readValue<T>(slot: SemanticSlot): T | undefined {
    this.evaluate(slot);
    return this.states[slot] === 1 && this.freshnessState(slot) !== "stale" ? (this.values[slot] as T) : undefined;
  }

  readNumber(slot: SemanticSlot): number | undefined {
    this.evaluate(slot);
    const value = this.values[slot];
    return this.states[slot] === 1 && this.freshnessState(slot) !== "stale" && typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  readBoolean(slot: SemanticSlot): boolean | undefined {
    this.evaluate(slot);
    const value = this.values[slot];
    if (this.states[slot] !== 1 || this.freshnessState(slot) === "stale") {
      return undefined;
    }
    return typeof value === "boolean" ? value : typeof value === "number" && Number.isFinite(value) ? value !== 0 : undefined;
  }

  resolveValue<T>(slot: SemanticSlot): ResolvedValue<T> {
    return this.resolve(slot) as ResolvedValue<T>;
  }

  resolveNumber(slot: SemanticSlot): ResolvedValue<number> {
    return this.resolve(slot, "number") as ResolvedValue<number>;
  }

  resolveBoolean(slot: SemanticSlot): ResolvedValue<boolean> {
    return this.resolve(slot, "boolean") as ResolvedValue<boolean>;
  }

  resolveMany(slots: readonly SemanticSlot[], target: ResolvedValue<unknown>[] = []): readonly ResolvedValue<unknown>[] {
    target.length = slots.length;
    for (let index = 0; index < slots.length; index += 1) {
      target[index] = this.resolve(slots[index]);
    }
    return target;
  }

  private evaluate(slot: SemanticSlot): void {
    if (slot < 0 || slot >= this.resolver.plans.length) {
      throw new RangeError(`Unknown semantic slot ${slot}`);
    }
    if (this.generations[slot] === this.generation) return;
    this.generations[slot] = this.generation;
    this.observations[slot] = undefined;
    this.observationDomains[slot] = undefined;
    this.sourceChannels[slot] = undefined;
    const plan = this.resolver.plans[slot];
    try {
      if (plan.executorError) {
        this.values[slot] = undefined;
        this.states[slot] = 5;
        return;
      }
      if (plan.derivation) {
        this.derivationDepth += 1;
        const depth = this.derivationDepth;
        this.dependencyStates[depth] = 1;
        this.dependencyObservations[depth] = undefined;
        this.dependencyDomains[depth] = undefined;
        let result: DerivationResult;
        let dependencyState: number;
        let dependencyObservation: SourceObservation | undefined;
        let dependencyDomain: ObservationDomain | undefined;
        try {
          result = plan.derivation.evaluate(this.derivationContext);
        } finally {
          dependencyState = this.dependencyStates[depth];
          dependencyObservation = this.dependencyObservations[depth];
          dependencyDomain = this.dependencyDomains[depth];
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
            this.observations[slot] = dependencyObservation ?? this.observation;
            this.observationDomains[slot] = dependencyDomain ?? this.observation.timestamp.domain;
          }
        } else {
          this.observations[slot] = dependencyObservation;
          this.observationDomains[slot] = dependencyDomain;
          this.values[slot] = undefined;
          this.states[slot] = dependencyState !== 1 ? dependencyState : result.state === "invalid" ? 3 : result.state === "error" ? 5 : result.state === "not-applicable" ? 4 : 2;
        }
        return;
      }
      const reading = plan.reader?.(this.native, this.readerContext);
      if (reading === undefined || reading.value === null) {
        this.values[slot] = undefined;
        this.states[slot] = plan.mapping.kind === "unavailable" && plan.mapping.reason === "not-applicable" ? 4 : 2;
      } else {
        const value = canonicalValue(plan.variable, reading.value);
        if (value === INVALID_VALUE) {
          this.values[slot] = undefined;
          this.states[slot] = 3;
        } else {
          this.values[slot] = value;
          this.states[slot] = 1;
          this.observations[slot] = reading.observation;
          this.observationDomains[slot] = reading.observation.timestamp.domain;
          this.sourceChannels[slot] = reading.sourceChannel;
        }
      }
    } catch {
      this.values[slot] = undefined;
      this.states[slot] = 5;
      this.observations[slot] = undefined;
      this.observationDomains[slot] = undefined;
      this.sourceChannels[slot] = undefined;
    }
  }
  freshnessState(slot: SemanticSlot): FreshnessState {
    if (this.states[slot] === 6) return "stale";
    const threshold = this.resolver.plans[slot].staleAfterMs;
    if (!Number.isFinite(threshold)) return "fresh";
    const sourceObservation = this.observations[slot];
    if (sourceObservation === undefined || this.observationDomains[slot] === "mixed") {
      return "unknown";
    }
    const age = ageMilliseconds(this.observation.timestamp, sourceObservation.timestamp);
    if (age === undefined) return "unknown";
    return age <= threshold ? "fresh" : "stale";
  }

  private resolve(slot: SemanticSlot, expected?: "number" | "boolean"): ResolvedValue<unknown> {
    this.evaluate(slot);
    const plan = this.resolver.plans[slot];
    let value: unknown = this.states[slot] === 1 ? this.values[slot] : null;
    let state: ResolutionState =
      this.states[slot] === 1
        ? "ok"
        : this.states[slot] === 2
          ? "missing"
          : this.states[slot] === 3
            ? "invalid"
            : this.states[slot] === 4
              ? "not-applicable"
              : this.states[slot] === 6
                ? "stale"
                : "error";
    if (expected === "number" && typeof value !== "number") {
      value = null;
      if (state === "ok") state = "invalid";
    }
    if (expected === "boolean") {
      if (typeof value === "number" && Number.isFinite(value)) {
        value = value !== 0;
      } else if (typeof value !== "boolean") {
        value = null;
        if (state === "ok") state = "invalid";
      }
    }
    const mappingStatus = plan.mapping.kind;
    const fidelity = mappingStatus === "direct" ? 1 : mappingStatus === "normalized" ? 0.99 : mappingStatus === "derived" ? 0.95 : mappingStatus === "simplified" ? 0.7 : 0;
    const freshness = this.freshnessState(slot);
    if (state === "ok" && freshness === "stale") state = "stale";
    const freshnessConfidence = freshness === "fresh" ? 1 : freshness === "stale" ? 0 : null;
    const completeness = state === "ok" || (state === "stale" && value !== null) ? 1 : 0;
    const confidence = completeness === 0 ? 0 : freshnessConfidence === null ? null : fidelity * freshnessConfidence * completeness;
    const source = this.sourceChannels[slot] ?? (plan.mapping.kind === "unavailable" ? undefined : sources(plan.mapping)[0]);
    const sourceObservation = this.observationDomains[slot] === "mixed" ? undefined : this.observations[slot];
    return {
      semanticId: plan.semanticId,
      value,
      unit: plan.mapping.kind === "unavailable" ? null : plan.variable.canonicalUnit,
      mappingStatus,
      state,
      confidence,
      freshness,
      sourceFreshness:
        plan.mapping.kind === "unavailable" ? null : plan.mapping.freshness,
      confidenceComponents: {
        semanticFidelity: fidelity,
        freshness: freshnessConfidence,
        inputCompleteness: completeness,
        ...(plan.derivation
          ? {
              derivationReliability: plan.derivation.deterministic ? 1 : 0.8,
            }
          : {}),
      },
      provenance: {
        simulator: this.resolver.simulator,
        parserId: this.resolver.parserId,
        parserVersion: this.resolver.parserVersion,
        ...(source && plan.mapping.kind !== "unavailable" ? { sourceChannel: source, sourceUnit: plan.mapping.nativeUnit } : {}),
        resolverVersion: TELEMETRY_RESOLVER_VERSION,
        catalogVersion: this.resolver.catalogVersion,
        catalogHash: this.resolver.catalogHash,
        ...(plan.derivation
          ? {
              derivation: {
                id: plan.derivation.id,
                version: plan.derivation.version,
                codeHash: plan.derivation.codeHash,
              },
            }
          : {}),
        observedAt: this.observation.timestamp,
        ...(sourceObservation ? { sourceObservation } : {}),
      },
      schemaVersion: this.resolver.schemaVersion,
      limitations: plan.mapping.kind === "unavailable" ? [plan.mapping.description] : plan.executorError ? [...plan.mapping.limitations, plan.executorError] : plan.mapping.limitations,
    };
  }
}
