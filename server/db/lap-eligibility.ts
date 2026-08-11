import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { EligibilityPolicyId, EligibilityStatus } from "../../shared/racing/quality/contracts";

export const USABLE_ELIGIBILITY_STATUSES = ["eligible", "eligible_with_warning"] as const satisfies readonly EligibilityStatus[];

/** Read one persisted policy decision. Policy rules never live in SQL. */
export function analysisEligibility(table: { eligibility: AnySQLiteColumn }, policyId: EligibilityPolicyId, acceptedStatuses: readonly EligibilityStatus[] = USABLE_ELIGIBILITY_STATUSES): SQL {
  return inArray(sql<string>`json_extract(${table.eligibility}, ${`$."${policyId}".status`})`, [...acceptedStatuses]);
}
