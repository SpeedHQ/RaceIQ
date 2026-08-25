import { eq } from "drizzle-orm";
import type { RaceEventId } from "../../shared/racing/events/contracts";
import type { TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import {
  CanonicalArchiveAvailabilitySchema,
  type CanonicalArchiveAvailability,
} from "../../shared/racing/archives/contracts";
import { getActiveAnalysisReceipt } from "../db/analysis-receipt-queries";
import { getActiveVerifiedCanonicalArchive } from "../db/canonical-archive-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { validateCanonicalArchiveReceipt } from "../analysis-provenance/receipt";

function unavailable(details: string, extra: Partial<CanonicalArchiveAvailability> = {}): CanonicalArchiveAvailability {
  return CanonicalArchiveAvailabilitySchema.parse({
    state: "unavailable",
    status: null,
    completeness: null,
    archiveId: null,
    generationId: null,
    semanticIds: [],
    eventIds: [],
    provenance: null,
    details,
    ...extra,
  });
}

/**
 * Availability requires active receipt, matching durable archive row, matching
 * output hash, and readable archive file. Partial archives remain readable for
 * replay but never become raw-removal eligible.
 */
export async function getSessionCanonicalAvailability(sessionId: number): Promise<CanonicalArchiveAvailability | null> {
  const session = await db.select({ id: sessions.id, gameId: sessions.gameId }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  if (!active?.receipt) return unavailable("No verified active canonical archive receipt");
  try {
    const receipt = validateCanonicalArchiveReceipt(active.receipt);
    const archiveOutput = receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
    if (!archiveOutput?.contentHash) return unavailable("Canonical archive receipt output inventory is incomplete");
    const archive = await getActiveVerifiedCanonicalArchive(sessionId, { verifyOutput: true });
    if (!archive) return unavailable("Canonical archive row, file, or output hash is unavailable");
    const common = {
      status: archive.status,
      completeness: archive.completeness as "complete" | "partial" | "empty" | "unavailable",
      archiveId: archive.archiveId,
      generationId: archive.generationId,
      semanticIds: (receipt.canonicalInventory?.semanticIds ?? []) as TelemetryVariableId[],
      eventIds: (receipt.canonicalInventory?.eventIds ?? []) as RaceEventId[],
    };
    if (
      archive.status !== "verified"
      || archive.completeness !== "complete"
      || !archive.outputContentHash
      || archiveOutput.contentHash !== archive.outputContentHash
      || receipt.context.gameId !== session.gameId
      || archive.context.gameId !== session.gameId
    ) return unavailable("Canonical archive is partial, mismatched, or not verified; raw capture must remain", common);
    return CanonicalArchiveAvailabilitySchema.parse({
      state: "available",
      ...common,
      provenance: {
        archiveIdentity: archive.archiveId,
        schemaIdentity: archive.schemaVersion,
        configIdentity: receipt.configuration.hash,
        sourceIdentity: archive.sourceContentHash,
        outputIdentity: archive.outputContentHash,
      },
      details: null,
    });
  } catch {
    return unavailable("Canonical archive receipt or durable output failed verification");
  }
}
