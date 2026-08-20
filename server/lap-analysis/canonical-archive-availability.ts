import { eq } from "drizzle-orm";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CanonicalArchiveAvailability } from "../../shared/racing/quality/retention";
import { getActiveAnalysisReceipt } from "../db/analysis-receipt-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { validateCanonicalArchiveReceipt } from "../analysis-provenance/receipt";
/**
 * Availability comes only from verified active receipt inventory. Persisted
 * SQL quality or decoded raw packets cannot prove canonical archive durability.
 */
export async function getSessionCanonicalAvailability(sessionId: number): Promise<CanonicalArchiveAvailability | null> {
  const session = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  if (!active?.receipt) {
    return {
      state: "unavailable",
      semanticIds: [],
      eventIds: [],
      provenance: null,
      details: "No verified active canonical archive receipt",
    };
  }
  try {
    const receipt = validateCanonicalArchiveReceipt(active.receipt);
    const archiveOutput = receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
    return {
      state: "available",
      semanticIds: receipt.canonicalInventory!.semanticIds as TelemetryVariableId[],
      eventIds: receipt.canonicalInventory!.eventIds,
      provenance: {
        archiveIdentity: receipt.evidence.objectId,
        schemaIdentity: receipt.receiptSchemaVersion,
        configIdentity: receipt.configuration.hash,
        sourceIdentity: receipt.evidence.contentHash!,
        outputIdentity: archiveOutput!.contentHash!,
      },
      details: null,
    };
  } catch {
    return {
      state: "unavailable",
      semanticIds: [],
      eventIds: [],
      provenance: null,
      details: "Canonical archive receipt failed verification",
    };
  }
}
