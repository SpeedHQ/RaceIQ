import type { GameId } from "../../games/ids";
import type { TelemetryPacket } from "../types";

export type TelemetryLinkKind =
  | "direct"
  | "normalized"
  | "derived"
  | "simplified"
  | "unavailable";

export type TelemetryValueType =
  | "number"
  | "boolean"
  | "string"
  | "enum"
  | "structured";

export type TelemetryValueCardinality =
  | { kind: "scalar" }
  | { kind: "fixed"; count: number }
  | { kind: "variable"; min: number; max?: number };

export interface TelemetryStructuredIndexSchema {
  id: string;
  cardinality: TelemetryValueCardinality;
  ordering: "numeric-ascending" | "source-order" | "semantic-order";
}

export interface TelemetryStructuredFieldSchema {
  id: string;
  valueType: Exclude<TelemetryValueType, "structured">;
  dimensions: readonly string[];
  enumDomain?: readonly string[];
}

export interface TelemetryStructuredValueSchema {
  indices: readonly TelemetryStructuredIndexSchema[];
  fields: readonly TelemetryStructuredFieldSchema[];
}

export interface TelemetryMappingExecution {
  kind: "conversion" | "derivation" | "simplification";
  id: string;
  version: string;
  codeHash: string;
  deterministic: boolean;
  declaredInputs: readonly string[];
  missingDataPolicy: "propagate-missing" | "drop-missing" | "require-all";
}

export interface TelemetryMappingProvenance {
  origin: "parser" | "projection" | "schema" | "yaml" | "derivation";
  artifact: string;
  commit: string;
}

export interface TelemetryCompatibilityReview {
  id: string;
  rationale: string;
}

export interface AvailableTelemetryLink {
  kind: Exclude<TelemetryLinkKind, "unavailable">;
  nativeUnit: string;
  sources: readonly string[] | Record<string, readonly string[]>;
  freshness: "continuous" | "pit-snapshot" | "session-update" | "static";
  normalization?: string;
  description: string;
  limitations: readonly string[];
  provenance: TelemetryMappingProvenance;
  execution?: TelemetryMappingExecution;
  compatibilityReview?: TelemetryCompatibilityReview;
}

export interface UnavailableTelemetryLink {
  kind: "unavailable";
  reason:
    | "source-not-provided"
    | "parser-placeholder"
    | "source-not-populated"
    | "not-applicable";
  description: string;
}

export type TelemetryGameLink = AvailableTelemetryLink | UnavailableTelemetryLink;

export interface TelemetryCatalogGroup {
  id: string;
  label: string;
  description: string;
  parentId?: string;
  canonicalUnit?: string;
  children: readonly string[];
}

export interface TelemetryVariableDefinition {
  id: string;
  label: string;
  description: string;
  parentId: string;
  canonicalUnit: string;
  valueType: TelemetryValueType;
  dimensions: readonly string[];
  cardinality: TelemetryValueCardinality;
  ordering?: readonly string[];
  range?: { min: number; max: number };
  enumDomain?: readonly string[];
  structuredSchema?: TelemetryStructuredValueSchema;
  limitations: readonly string[];
  shape: "scalar" | "per-wheel" | "vector" | "array" | "structured";
  packetFields?: readonly (keyof TelemetryPacket)[];
  games: Record<GameId, TelemetryGameLink>;
}

export interface TelemetrySourceVariable {
  path: string;
  label: string;
  unit: string;
  dataType?: string;
  count?: number;
  description: string;
  semanticId: string;
  sourceKind: "packet" | "extension" | "sdk" | "yaml" | "setup";
  recordedByRaceIQ: boolean;
  retention: "exact" | "normalized" | "not-recorded";
}

export interface TelemetrySourceCoverage {
  total: number;
  packet: number;
  extension: number;
  sdk: number;
  yaml: number;
  setup: number;
  recorded: number;
}

export interface TelemetryCatalogMetadata {
  catalogVersion: string;
  schemaVersion: string;
  generator: {
    name: string;
    version: string;
    commit: string;
  };
  generatedAt: string;
  contentHash: string;
}

export interface TelemetryCatalogData {
  format: "raceiq-semantic-telemetry-catalog-v6";
  metadata: TelemetryCatalogMetadata;
  generatedFrom: readonly string[];
  groups: readonly TelemetryCatalogGroup[];
  variables: readonly TelemetryVariableDefinition[];
  sources: Record<GameId, readonly TelemetrySourceVariable[]>;
  coverage: {
    normalizedPacketFields: number;
    semanticVariables: number;
    sourceCounts: Record<GameId, TelemetrySourceCoverage>;
  };
}
