import {
  TELEMETRY_CATALOG_GENERATED,
  TELEMETRY_CATALOG_HASH as GENERATED_TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION as GENERATED_TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION as GENERATED_TELEMETRY_CATALOG_VERSION,
} from "./generated/telemetry-catalog.generated";
import type { TelemetryCatalogData } from "./contracts";

/**
 * Central telemetry-first catalog. Generated from normalized packet types,
 * every registered parser output, parser-specific extension interfaces,
 * captured iRacing SDK variable table, and known SessionInfo YAML schema.
 */
export const TELEMETRY_CATALOG =
  TELEMETRY_CATALOG_GENERATED as unknown as TelemetryCatalogData;

export const TELEMETRY_CATALOG_VERSION =
  GENERATED_TELEMETRY_CATALOG_VERSION;
export const TELEMETRY_CATALOG_SCHEMA_VERSION =
  GENERATED_TELEMETRY_CATALOG_SCHEMA_VERSION;
export const TELEMETRY_CATALOG_HASH = GENERATED_TELEMETRY_CATALOG_HASH;
