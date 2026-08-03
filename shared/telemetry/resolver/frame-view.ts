import type { DerivationContext, DerivationResult } from "../derivations/contracts";
import type { ResolvedValue, ResolutionState, SemanticSlot, TelemetryFrameView } from "./contracts";
import type { NativeObject, RuntimeResolver } from "./plan";
import { INVALID_VALUE, canonicalValue, sources } from "./value";
import { TELEMETRY_RESOLVER_VERSION } from "./versions";

export class FrameView<NativeFrame> implements TelemetryFrameView<NativeFrame> {
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
  readonly resolver: RuntimeResolver;

  constructor(resolver: RuntimeResolver, count: number) {
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
