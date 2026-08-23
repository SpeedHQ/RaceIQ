import { eq } from "drizzle-orm";
import type { CanonicalArchiveAvailability } from "../../shared/racing/quality/retention";
import { getActiveAnalysisReceipt } from "../db/analysis-receipt-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
/**
 * No canonical backing-store reader or producer is registered. Receipt metadata
 * alone cannot verify stored bytes, readability, output hash, or inventory.
 */
export async function getSessionCanonicalAvailability(sessionId: number): Promise<CanonicalArchiveAvailability | null> {
  const session = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  return {
    state: "unavailable",
    semanticIds: [],
    eventIds: [],
    provenance: null,
    details: active?.receipt
      ? "Canonical archive receipt metadata exists, but no storage reader can verify bytes or inventory"
      : "Canonical archive storage verification unavailable",
  };
}
