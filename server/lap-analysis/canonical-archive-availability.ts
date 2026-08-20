import { eq } from "drizzle-orm";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { CanonicalArchiveAvailability } from "../../shared/racing/quality/retention";
import { getActiveAnalysisReceipt } from "../db/analysis-receipt-queries";
import { getActiveVerifiedCanonicalArchive } from "../db/canonical-archive-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { validateCanonicalArchiveReceipt } from "../analysis-provenance/receipt";

function unavailable(details: string, extra: Partial<CanonicalArchiveAvailability> = {}): CanonicalArchiveAvailability {
  return {
    state: "unavailable",
    semanticIds: [],
    eventIds: [],
    provenance: null,
    details,
    ...extra,
  };
}

/**
 * Availability requires active receipt, matching durable archive row, matching
 * output hash, and readable archive file. Partial archives remain readable for
 * replay but never become raw-removal eligible.
 */
export async function getSessionCanonicalAvailability(sessionId: number): Promise<CanonicalArchiveAvailability | null> {
  const session = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  if (!active?.receipt) return unavailable("No verified active canonical archive receipt");
  try {
    const receipt = validateCanonicalArchiveReceipt(active.receipt);
    const archiveOutput = receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
    if (!archiveOutput?.contentHash || !receipt.evidence.contentHash) return unavailable("Canonical archive receipt output inventory is incomplete");
    const archive = await getActiveVerifiedCanonicalArchive(sessionId);
    if (!archive) return unavailable("Canonical archive row, file, or output hash is unavailable");
    const semanticIds = receipt.canonicalInventory?.semanticIds as TelemetryVariableId[] ?? [];
    const common = {
      semanticIds,
      eventIds: receipt.canonicalInventory?.eventIds ?? [],
      archiveId: archive.archiveId,
      generationId: archive.generationId,
      status: archive.status,
      completeness: archive.completeness as "complete" | "partial" | "empty" | "unavailable",
    };
    if (archive.status !== "verified" || archive.completeness !== "complete") {
      return unavailable("Canonical archive is partial or not verified; raw capture must remain", common);
    }
    return {
      state: "available",
      ...common,
      provenance: {
        archiveIdentity: receipt.evidence.objectId,
        schemaIdentity: receipt.receiptSchemaVersion,
        configIdentity: receipt.configuration.hash,
        sourceIdentity: receipt.evidence.contentHash,
        outputIdentity: archiveOutput.contentHash,
      },
      details: null,
    };
  } catch {
    return unavailable("Canonical archive receipt or durable output failed verification");
  }
}
