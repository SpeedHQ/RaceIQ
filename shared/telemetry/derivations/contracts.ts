import type { TelemetryLinkKind } from "../catalog/contracts";

export type DerivationMissingDataPolicy =
  | "unavailable"
  | "hold-last"
  | "interpolate"
  | "partial";

export type MappingStatus = TelemetryLinkKind;

export interface MappingInputRequirement {
  semanticId: string;
  acceptedMappings: readonly MappingStatus[];
  required: boolean;
}

export interface DerivationOutput {
  semanticId: string;
  unit: string;
  valueType: "number" | "boolean" | "enum" | "string" | "structured";
}

export interface DerivationWindow {
  durationMs?: number;
  samples?: number;
  alignment: "event-time" | "frame-order";
}

export type DerivationState =
  | "ok"
  | "missing"
  | "stale"
  | "invalid"
  | "not-applicable"
  | "error";

export interface DerivationResultValue<T> {
  state: "ok";
  value: T;
}

export interface DerivationResultUnavailable {
  state: "missing" | "invalid" | "not-applicable" | "error";
  reason?: string;
}

export type DerivationResult<T = unknown> =
  | DerivationResultValue<T>
  | DerivationResultUnavailable;

export interface DerivationContext {
  number(semanticId: string): number | undefined;
  boolean(semanticId: string): boolean | undefined;
  text(semanticId: string): string | undefined;
  structured<T>(semanticId: string): T | undefined;
  unavailable(reason?: string): DerivationResult;
  value<T>(value: T): DerivationResult<T>;
}

export interface TelemetryDerivation {
  readonly id: string;
  readonly version: string;
  readonly output: DerivationOutput;
  readonly inputs: readonly MappingInputRequirement[];
  readonly window?: DerivationWindow;
  readonly missingDataPolicy: DerivationMissingDataPolicy;
  readonly deterministic: boolean;
  readonly codeHash: string;
  evaluate(context: DerivationContext): DerivationResult;
}
