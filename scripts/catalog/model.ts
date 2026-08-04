import { resolve } from "node:path";

// Shared catalog model and generator configuration.
// Keep path resolution anchored to repository root after this module moves under scripts/catalog.
const IRACING_SESSION_INFO_SOURCE_FILES = [
  "shared/games/iracing/session-info/catalog.ts",
  "shared/games/iracing/session-info/contracts.ts",
  "shared/games/iracing/session-info/formatting.ts",
  "shared/games/iracing/session-info/sections.ts",
  "shared/games/iracing/session-info/setup-aero-drivetrain.ts",
  "shared/games/iracing/session-info/setup-builders.ts",
  "shared/games/iracing/session-info/setup-captured.ts",
  "shared/games/iracing/session-info/setup-chassis.ts",
  "shared/games/iracing/session-info/setup-in-car.ts",
  "shared/games/iracing/session-info/setup-tires.ts",
] as const;

const GAME_IDS = [
  "fm-2023",
  "f1-2025",
  "acc",
  "ac-evo",
  "iracing",
] as const;
type GameId = (typeof GAME_IDS)[number];

// Babel's public parser result is a large discriminated union. Generator only
// needs generic traversal and a small set of well-known node properties.
// biome-ignore lint/suspicious/noExplicitAny: generic AST traversal is clearer with Babel's runtime node shape
type AstNode = Record<string, any>;

interface SourceVariable {
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

type ValueType =
  | "number"
  | "boolean"
  | "string"
  | "enum"
  | "structured";

type ValueCardinality =
  | { kind: "scalar" }
  | { kind: "fixed"; count: number }
  | { kind: "variable"; min: number; max?: number };

interface StructuredIndexSchema {
  id: string;
  cardinality: ValueCardinality;
  ordering: "numeric-ascending" | "source-order" | "semantic-order";
}

interface StructuredFieldSchema {
  id: string;
  valueType: Exclude<ValueType, "structured">;
  dimensions: readonly string[];
  enumDomain?: readonly string[];
}

interface StructuredValueSchema {
  indices: readonly StructuredIndexSchema[];
  fields: readonly StructuredFieldSchema[];
}

interface MappingExecution {
  kind: "conversion" | "derivation" | "simplification";
  id: string;
  version: string;
  codeHash: string;
  deterministic: boolean;
  declaredInputs: readonly string[];
  missingDataPolicy: "propagate-missing" | "drop-missing" | "require-all";
}

interface MappingProvenance {
  origin:
    | "parser"
    | "projection"
    | "schema"
    | "yaml"
    | "derivation";
  artifact: string;
  commit: string;
}

interface CompatibilityReview {
  id: string;
  rationale: string;
}

interface AvailableLink {
  kind: "direct" | "normalized" | "derived" | "simplified";
  nativeUnit: string;
  sources: string[] | Record<string, string[]>;
  freshness: "continuous" | "pit-snapshot" | "session-update" | "static";
  normalization?: string;
  description: string;
  limitations?: readonly string[];
  provenance?: MappingProvenance;
  execution?: MappingExecution;
  compatibilityReview?: CompatibilityReview;
}

interface UnavailableLink {
  kind: "unavailable";
  reason:
    | "source-not-provided"
    | "parser-placeholder"
    | "source-not-populated"
    | "not-applicable";
  description: string;
}

type GameLink = AvailableLink | UnavailableLink;

interface CatalogGroup {
  id: string;
  label: string;
  description: string;
  parentId?: string;
  canonicalUnit?: string;
  children: string[];
}

interface CatalogVariable {
  id: string;
  label: string;
  description: string;
  parentId: string;
  canonicalUnit: string;
  valueType?: ValueType;
  dimensions?: readonly string[];
  cardinality?: ValueCardinality;
  ordering?: readonly string[];
  range?: {
    min: number;
    max: number;
  };
  enumDomain?: readonly string[];
  structuredSchema?: StructuredValueSchema;
  limitations?: readonly string[];
  shape: "scalar" | "per-wheel" | "vector" | "array" | "structured";
  packetFields?: string[];
  games: Record<GameId, GameLink>;
}

interface CatalogMetadata {
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

export interface BuiltTelemetryCatalog {
  format: "raceiq-semantic-telemetry-catalog-v6";
  metadata: CatalogMetadata;
  generatedFrom: readonly string[];
  groups: readonly CatalogGroup[];
  variables: readonly CatalogVariable[];
  sources: Record<GameId, readonly SourceVariable[]>;
  coverage: {
    normalizedPacketFields: number;
    semanticVariables: number;
    sourceCounts: Record<
      GameId,
      {
        total: number;
        packet: number;
        extension: number;
        sdk: number;
        yaml: number;
        setup: number;
        recorded: number;
      }
    >;
  };
}

interface FieldInfo {
  name: string;
  type: string;
  description?: string;
}

interface ExtensionFieldSet {
  key: string;
  semanticKey: string;
  paths: string[];
  type: string;
  description?: string;
  shape: CatalogVariable["shape"];
  wheelPaths?: Record<string, string>;
}

interface SemanticDefinition {
  label: string;
  description: string;
  parentId: string;
  canonicalUnit: string;
  shape: CatalogVariable["shape"];
  valueType?: ValueType;
  dimensions?: readonly string[];
  cardinality?: ValueCardinality;
  ordering?: readonly string[];
  range?: { min: number; max: number };
  enumDomain?: readonly string[];
  limitations?: readonly string[];
}

interface ExtensionMetadata {
  semanticId: string;
  unit?: string;
  description?: string;
  kind?: AvailableLink["kind"];
  normalization?: string;
  freshness?: AvailableLink["freshness"];
}

interface UnavailableExtensionSource {
  reason: UnavailableLink["reason"];
  description: string;
}

interface FieldSet {
  key: string;
  fields: string[];
  shape: CatalogVariable["shape"];
  wheelFields?: Record<string, string>;
}

interface ParserOutput {
  source: string;
  properties: Map<string, AstNode>;
  variables: Map<string, AstNode>;
}
const ROOT = resolve(import.meta.dirname, "../..");
const TELEMETRY_TYPE_SOURCE_FILES = [
  "shared/telemetry/types.ts",
  "shared/telemetry/f1-2025.ts",
  "shared/telemetry/kunos.ts",
  "shared/telemetry/iracing.ts",
] as const;
const GENERATED_OUTPUT_DIRECTORY = resolve(
  ROOT,
  "shared/telemetry/catalog/generated",
);
const OUTPUT_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "telemetry-catalog.generated.json",
);
const OUTPUT_TS_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "telemetry-catalog.generated.ts",
);
const OUTPUT_MARKDOWN_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "TELEMETRY_CATALOG.md",
);
const OUTPUT_MATRIX_PATH = resolve(
  GENERATED_OUTPUT_DIRECTORY,
  "telemetry-catalog-matrix.md",
);
const IRACING_DIAGNOSTIC = resolve(
  ROOT,
  "data/diagnostics/iracing-all-vars-2026-07-29T02-06-39-162Z.json",
);
const IRACING_SESSION_INFO_CAPTURE_DIRECTORY = resolve(
  ROOT,
  "data/diagnostics/iracing-session-info",
);
const PACKAGE_JSON_PATH = resolve(ROOT, "package.json");

const PACKAGE_VERSION = JSON.parse(
  await Bun.file(PACKAGE_JSON_PATH).text(),
).version as string;
const GENERATOR_NAME = "RaceIQ telemetry-catalog generator";
const CATALOG_FORMAT = "raceiq-semantic-telemetry-catalog-v6";
const CATALOG_SCHEMA_VERSION = "v6";
const DERIVATION_VERSION = `${PACKAGE_VERSION}`;

const PARSER_FILES: Record<GameId, string> = {
  "fm-2023": "server/games/fm-2023/parser.ts",
  "f1-2025": "server/games/f1-2025/f1-state.ts",
  acc: "server/games/acc/parser.ts",
  "ac-evo": "server/games/ac-evo/parser.ts",
  iracing: "server/games/iracing/normalizer.ts",
};
export {
  IRACING_SESSION_INFO_SOURCE_FILES,
  GAME_IDS,
  ROOT,
  TELEMETRY_TYPE_SOURCE_FILES,
  GENERATED_OUTPUT_DIRECTORY,
  OUTPUT_PATH,
  OUTPUT_TS_PATH,
  OUTPUT_MARKDOWN_PATH,
  OUTPUT_MATRIX_PATH,
  IRACING_DIAGNOSTIC,
  IRACING_SESSION_INFO_CAPTURE_DIRECTORY,
  PACKAGE_JSON_PATH,
  PACKAGE_VERSION,
  GENERATOR_NAME,
  CATALOG_FORMAT,
  CATALOG_SCHEMA_VERSION,
  DERIVATION_VERSION,
  PARSER_FILES,
};

export type {
  GameId,
  AstNode,
  SourceVariable,
  ValueType,
  ValueCardinality,
  StructuredIndexSchema,
  StructuredFieldSchema,
  StructuredValueSchema,
  MappingExecution,
  MappingProvenance,
  CompatibilityReview,
  AvailableLink,
  UnavailableLink,
  GameLink,
  CatalogGroup,
  CatalogVariable,
  CatalogMetadata,
  FieldInfo,
  ExtensionFieldSet,
  SemanticDefinition,
  ExtensionMetadata,
  UnavailableExtensionSource,
  FieldSet,
  ParserOutput,
};