import type { GameId } from "../../games/ids";
import type {
  TelemetryGroupId,
  TelemetryMappingSourcePath,
  TelemetryNodeId,
  TelemetrySourcePath,
  TelemetryVariableId,
} from "./generated/telemetry-catalog.types";
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

export interface TelemetryMappingInputRequirement {
  semanticId: string;
  acceptedMappings: readonly TelemetryLinkKind[];
  required: boolean;
}

export interface TelemetryMappingExecution {
  kind: "conversion" | "derivation" | "simplification";
  id: string;
  version: string;
  codeHash: string;
  deterministic: boolean;
  inputs:
    | readonly TelemetryMappingSourcePath<GameId>[]
    | readonly TelemetryMappingInputRequirement[];
  missingDataPolicy:
    | "propagate-missing"
    | "drop-missing"
    | "require-all"
    | "unavailable"
    | "hold-last"
    | "interpolate"
    | "partial";
}

export interface TelemetryMappingProvenance {
  origin: "parser" | "projection" | "schema" | "yaml" | "derivation";
  artifact: string;
}

export interface TelemetryCompatibilityReview {
  id: string;
  rationale: string;
}

export interface AvailableTelemetryLink<G extends GameId = GameId> {
  kind: Exclude<TelemetryLinkKind, "unavailable">;
  nativeUnit: string;
  sources: readonly TelemetryMappingSourcePath<G>[] | Record<string, readonly TelemetryMappingSourcePath<G>[]>;
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

export type TelemetryGameLink<G extends GameId = GameId> = AvailableTelemetryLink<G> | UnavailableTelemetryLink;

export interface TelemetryCatalogGroup {
  id: TelemetryGroupId;
  label: string;
  description: string;
  parentId?: TelemetryGroupId;
  canonicalUnit?: string;
  children: readonly TelemetryNodeId[];
}

export interface TelemetryVariableDefinition {
  id: TelemetryVariableId;
  label: string;
  description: string;
  parentId: TelemetryGroupId;
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
  games: { [G in GameId]: TelemetryGameLink<G> };
}

export interface TelemetrySourceVariable<G extends GameId = GameId> {
  path: TelemetrySourcePath<G>;
  label: string;
  unit: string;
  dataType?: string;
  count?: number;
  description: string;
  semanticId: TelemetryVariableId;
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
    sourceHash: string;
  };
  sourceHashes: Readonly<Record<string, string>>;
  contentHash: string;
}

export interface TelemetryCatalogData {
  format: "raceiq-semantic-telemetry-catalog-v8";
  metadata: TelemetryCatalogMetadata;
  generatedFrom: readonly string[];
  groups: readonly TelemetryCatalogGroup[];
  variables: readonly TelemetryVariableDefinition[];
  sources: { [G in GameId]: readonly TelemetrySourceVariable<G>[] };
  coverage: {
    normalizedPacketFields: number;
    semanticVariables: number;
    sourceCounts: Record<GameId, TelemetrySourceCoverage>;
  };
}
