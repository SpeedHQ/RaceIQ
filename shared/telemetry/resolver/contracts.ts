import type { GameId } from "../../games/ids";
import type { MappingStatus, TelemetryDerivation } from "../derivations/contracts";
import type { TelemetryPacket } from "../types";

export type SemanticSlot = number & { readonly __brand: "SemanticSlot" };

export type TelemetryTimestamp =
  | { readonly domain: "wall-clock"; readonly milliseconds: number }
  | { readonly domain: "session"; readonly milliseconds: number }
  | { readonly domain: "monotonic"; readonly nanoseconds: bigint };

export interface SourceObservation {
  readonly timestamp: TelemetryTimestamp;
  readonly updateSequence: bigint;
}

export type FreshnessState = "fresh" | "stale" | "unknown";
export type ResolutionState = "ok" | "missing" | "stale" | "invalid" | "not-applicable" | "error";

export interface ResolutionProvenance {
  simulator: GameId;
  parserId: string;
  parserVersion: string;
  sourceChannel?: string;
  sourceUnit?: string;
  resolverVersion: string;
  catalogVersion: string;
  catalogHash: string;
  derivation?: { id: string; version: string; codeHash: string };
  observedAt: TelemetryTimestamp;
  sourceObservation?: SourceObservation;
}

export interface ConfidenceComponents {
  semanticFidelity: number;
  freshness: number | null;
  inputCompleteness: number;
  derivationReliability?: number;
}

export interface ResolvedValue<T> {
  semanticId: string;
  value: T | null;
  unit: string | null;
  mappingStatus: MappingStatus;
  state: ResolutionState;
  confidence: number | null;
  freshness: FreshnessState;
  /** Catalog source cadence, distinct from current resolved freshness. */
  sourceFreshness:
    | "continuous"
    | "pit-snapshot"
    | "session-update"
    | "static"
    | null;
  confidenceComponents: ConfidenceComponents;
  provenance: ResolutionProvenance;
  schemaVersion: string;
  limitations: readonly string[];
}

export interface RequestedSemantic {
  semanticId: string;
  required?: boolean;
}

export interface ResolverCompileOptions {
  simulator: GameId;
  requested: readonly RequestedSemantic[];
  rejectSimplified?: boolean;
  staleAfterMs?: Readonly<Record<string, number>>;
  parserId?: string;
  parserVersion?: string;
  derivations?: readonly TelemetryDerivation[];
}

export interface TelemetryFrameView<NativeFrame = TelemetryPacket> {
  readonly __nativeFrameType?: NativeFrame;
  observation: SourceObservation;
  /** Clears retained non-continuous source observations before a new source epoch. */
  resetSourceState(): void;
  resolutionState(slot: SemanticSlot): ResolutionState;
  freshnessState(slot: SemanticSlot): FreshnessState;
  sourceFreshness(slot: SemanticSlot): ResolvedValue<unknown>["sourceFreshness"];
  has(slot: SemanticSlot): boolean;
  readValue<T>(slot: SemanticSlot): T | undefined;
  readNumber(slot: SemanticSlot): number | undefined;
  readBoolean(slot: SemanticSlot): boolean | undefined;
  resolveValue<T>(slot: SemanticSlot): ResolvedValue<T>;
  resolveNumber(slot: SemanticSlot): ResolvedValue<number>;
  resolveBoolean(slot: SemanticSlot): ResolvedValue<boolean>;
  resolveMany(slots: readonly SemanticSlot[], target?: ResolvedValue<unknown>[]): readonly ResolvedValue<unknown>[];
}

export interface CompiledTelemetryResolver<NativeFrame = TelemetryPacket> {
  readonly catalogVersion: string;
  readonly catalogHash: string;
  readonly schemaVersion: string;
  readonly simulator: GameId;
  readonly parserVersion: string;
  readonly resolverVersion: string;
  readonly derivationVersion: string;
  slot(semanticId: string): SemanticSlot;
  createFrameView(native: NativeFrame, observation: SourceObservation, reuse?: TelemetryFrameView<NativeFrame>): TelemetryFrameView<NativeFrame>;
}
