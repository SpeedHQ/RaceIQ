export { readFileSync } from "node:fs";
export {
  assertDirectToSimplifiedCompatibilityReviews,
  buildTelemetryCatalog,
  buildTelemetryCatalogArtifacts,
  telemetryCatalogSourceHash,
} from "../../../scripts/catalog/generate-telemetry-catalog";
export { collectIRacingSessionInfoLeafPaths } from "../../../scripts/catalog/iracing-session-info-capture";
export {
  TELEMETRY_CATALOG,
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
} from "../../../shared/telemetry/catalog/data";
export {
  getSourcesWithoutSemanticDefinition,
  getTelemetryChildren,
  getTelemetrySources,
  getTelemetryVariable,
  IRACING_SESSION_INFO_SOURCE_VARIABLES,
  IRACING_TELEMETRY_SOURCE_VARIABLES,
  isTelemetryEnumValue,
} from "../../../shared/telemetry/catalog/query";
export {
  assertTelemetryCatalogComplete,
  assertTelemetryCatalogDerivationContracts,
} from "../../../shared/telemetry/catalog/validation";
export { KNOWN_GAME_IDS } from "../../../shared/games/ids";
