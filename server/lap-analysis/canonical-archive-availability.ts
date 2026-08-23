import { eq } from "drizzle-orm";
import type { CanonicalArchiveAvailability } from "../../shared/racing/quality/retention";
import { db } from "../db/index";
import { sessions } from "../db/schema";

/**
 * Reads canonical-archive inventory metadata only.
 *
 * Canonical archive persistence/indexing is not present yet, so existing
 * sessions have no trustworthy canonical inventory to report. This query must
 * not infer availability from decoded raw packets or persisted lap quality.
 */
export async function getSessionCanonicalAvailability(sessionId: number): Promise<CanonicalArchiveAvailability | null> {
  const session = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;

  return {
    state: "unavailable",
    semanticIds: [],
    eventIds: [],
    provenance: null,
    details: "Canonical archive persistence and inventory metadata are unavailable",
  };
}
