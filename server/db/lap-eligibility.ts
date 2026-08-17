import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityPolicyId,
  type EligibilityStatus,
} from "../../shared/racing/quality/contracts";

export const USABLE_ELIGIBILITY_STATUSES = ["eligible", "eligible_with_warning"] as const satisfies readonly EligibilityStatus[];
type PersistedQualitySnapshotColumns = {
  quality: AnySQLiteColumn;
  qualitySchemaVersion: AnySQLiteColumn;
  qualityPolicyVersion: AnySQLiteColumn;
  qualityConfigVersion: AnySQLiteColumn;
  qualityGeneration: AnySQLiteColumn;
};

/** Require persisted quality columns and JSON provenance to describe one current snapshot. */
export function currentQualitySnapshot(table: PersistedQualitySnapshotColumns): SQL {
  return sql`(
    ${table.qualitySchemaVersion} = ${QUALITY_SCHEMA_VERSION}
    AND ${table.qualityPolicyVersion} = ${ELIGIBILITY_POLICY_VERSION}
    AND ${table.qualityConfigVersion} = ${QUALITY_CONFIG_VERSION}
    AND json_extract(${table.quality}, '$.provenance.schemaVersion') = ${QUALITY_SCHEMA_VERSION}
    AND json_extract(${table.quality}, '$.provenance.policyVersion') = ${ELIGIBILITY_POLICY_VERSION}
    AND json_extract(${table.quality}, '$.provenance.configurationVersion') = ${QUALITY_CONFIG_VERSION}
    AND ${table.qualityGeneration} = json_extract(${table.quality}, '$.provenance.outputGeneration')
    AND length(json_extract(${table.quality}, '$.provenance.sourceGeneration')) = 71
    AND substr(json_extract(${table.quality}, '$.provenance.sourceGeneration'), 1, 7) = 'sha256:'
    AND substr(json_extract(${table.quality}, '$.provenance.sourceGeneration'), 8) NOT GLOB '*[^0-9a-f]*'
    AND length(json_extract(${table.quality}, '$.provenance.outputGeneration')) = 71
    AND substr(json_extract(${table.quality}, '$.provenance.outputGeneration'), 1, 7) = 'sha256:'
    AND substr(json_extract(${table.quality}, '$.provenance.outputGeneration'), 8) NOT GLOB '*[^0-9a-f]*'
  )`;
}

/** Read one persisted policy decision. Policy rules never live in SQL. */
export function analysisEligibility(table: { eligibility: AnySQLiteColumn }, policyId: EligibilityPolicyId, acceptedStatuses: readonly EligibilityStatus[] = USABLE_ELIGIBILITY_STATUSES): SQL {
  return sql`(
    json_extract(${table.eligibility}, ${`$."${policyId}".policyId`}) = ${policyId}
    AND json_extract(${table.eligibility}, ${`$."${policyId}".policyVersion`}) = ${ELIGIBILITY_POLICY_VERSION}
    AND ${inArray(sql<string>`json_extract(${table.eligibility}, ${`$."${policyId}".status`})`, [...acceptedStatuses])}
  )`;
}
