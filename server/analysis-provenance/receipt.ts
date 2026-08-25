import { eq } from "drizzle-orm";

import type { GameId } from "../../shared/games/ids";
import {
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  AnalysisProvenanceReceiptSchema,
  type AnalysisProvenanceReceipt,
  type AnalysisReceiptFailure,
  type AnalysisVerificationCheck,
  type PersistedEvidenceKind,
} from "../../shared/racing/provenance/contracts";
import type { EvidenceSourceKind } from "../../shared/racing/quality/contracts";
import {
  activateAnalysisGeneration,
  beginAnalysisGeneration,
  failAnalysisGeneration,
  getActiveAnalysisReceipt,
  type AnalysisReceiptRow,
  type DbTransaction,
} from "../db/analysis-receipt-queries";
import { getActiveVerifiedCanonicalArchive } from "../db/canonical-archive-queries";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { inspectRawCaptureIdentity, rawCaptureObjectId } from "../session-capture/identity";
import { currentAnalysisContract } from "./current-contract";
import { buildPersistedSessionAnalysisInventory } from "./inventory";

const SESSION_ANALYSIS_ARTIFACTS = [
  "laps",
  "race_events",
  "session_runs",
  "race_result",
  "quality",
] as const;

function persistedEvidenceKind(source: EvidenceSourceKind, hasRaw: boolean): PersistedEvidenceKind {
  if (hasRaw) return "raceiq-raw";
  if (source === "native-live") return "unknown";
  return source;
}

export interface VerifiedCanonicalArchiveEvidence {
  archiveId: string;
  receipt: AnalysisProvenanceReceipt;
  outputContentHash: string;
  byteSize: number;
}

export async function loadVerifiedCanonicalArchiveEvidence(
  sessionId: number,
  gameId: GameId,
): Promise<VerifiedCanonicalArchiveEvidence | null> {
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  if (!active?.receipt) return null;
  const receipt = validateCanonicalArchiveReceipt(active.receipt);
  const output = receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
  const archive = await getActiveVerifiedCanonicalArchive(sessionId, { verifyOutput: true });
  if (
    !archive
    || archive.status !== "verified"
    || archive.completeness !== "complete"
    || archive.byteSize == null
    || !archive.outputContentHash
    || output?.contentHash !== archive.outputContentHash
    || receipt.context.gameId !== gameId
    || archive.context.gameId !== gameId
  ) return null;
  return { receipt, archiveId: archive.archiveId, outputContentHash: archive.outputContentHash, byteSize: archive.byteSize };
}

function completeVerification(
  inventoryChecks: readonly AnalysisVerificationCheck[],
  sourceAvailable: boolean,
): AnalysisVerificationCheck[] {
  const byId = new Map(inventoryChecks.map((check) => [check.id, check]));
  const sourceHash: AnalysisVerificationCheck = sourceAvailable
    ? { id: "source_hash", status: "passed", details: "Persisted evidence hash recorded" }
    : { id: "source_hash", status: "not_applicable", details: "No persisted source bytes available" };
  return [
    sourceHash,
    { id: "schema_supported", status: "passed", details: "Current receipt and output schemas supported" },
    byId.get("session_identity") ?? { id: "session_identity", status: "failed", details: "Session identity not verified" },
    byId.get("participant_identity") ?? { id: "participant_identity", status: "not_applicable", details: "Session artifact set has no participant scope" },
    byId.get("ordering") ?? { id: "ordering", status: "failed", details: "Canonical ordering not verified" },
    byId.get("coverage") ?? { id: "coverage", status: "failed", details: "Output coverage not verified" },
    { id: "channel_inventory", status: "passed", details: "Source channel profile captured in effective configuration" },
    { id: "partitions_readable", status: "not_applicable", details: "Session analysis uses SQLite artifacts" },
    { id: "analyse_read", status: "not_applicable", details: "Canonical archive reader not involved" },
    { id: "compare_read", status: "not_applicable", details: "Canonical archive reader not involved" },
    byId.get("storage_state") ?? { id: "storage_state", status: "failed", details: "Storage state not verified" },
  ];
}

export async function createPersistedSessionAnalysisReceipt(
  attempt: AnalysisReceiptRow,
  gameId: GameId,
  transaction?: DbTransaction,
  canonicalEvidence?: VerifiedCanonicalArchiveEvidence | null,
): Promise<AnalysisProvenanceReceipt> {
  const client = transaction ?? db;
  const [session] = await client.select().from(sessions).where(eq(sessions.id, attempt.sessionId)).limit(1);
  if (!session) throw new Error("Session not found");
  const raw = session.rawFile ? await inspectRawCaptureIdentity(session.rawFile) : undefined;
  const canonical = raw
    ? null
    : canonicalEvidence === undefined
      ? transaction ? null : await loadVerifiedCanonicalArchiveEvidence(attempt.sessionId, gameId)
      : canonicalEvidence;
  const source = (session.source as EvidenceSourceKind | null) ?? "unknown";
  const contract = currentAnalysisContract(gameId, session.sourceChannelProfile ?? null);
  if (contract.contractHash !== attempt.contractHash || contract.configurationHash !== attempt.configurationHash) {
    throw new Error("Analysis contract changed while generation was in progress");
  }
  const inventory = await buildPersistedSessionAnalysisInventory(attempt.sessionId, transaction);
  const now = new Date().toISOString();
  const receipt = {
    receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
    generationId: attempt.generationId,
    artifactSetId: attempt.artifactSetId,
    artifactSetType: "session_analysis" as const,
    generation: attempt.generation,
    lifecycle: "active" as const,
    sessionId: attempt.sessionId,
    participantId: attempt.participantId,
    evidence: raw
      ? {
          kind: persistedEvidenceKind(source, true),
          originalSourceKind: source,
          objectId: rawCaptureObjectId(attempt.sessionId),
          contentHash: raw.contentHash,
          byteSize: raw.byteSize,
          formatVersion: "raceiq-session-framing-v1",
          recordCounts: Object.fromEntries(inventory.outputs.map((entry) => [entry.name, entry.count])),
        }
      : canonical
        ? {
            kind: "canonical-archive" as const,
            originalSourceKind: canonical.receipt.evidence.originalSourceKind,
            objectId: canonical.archiveId,
            contentHash: canonical.outputContentHash,
            byteSize: canonical.byteSize,
            formatVersion: canonical.receipt.outputs.find((entry) => entry.artifactType === "canonical_archive")!.schemaVersion,
            recordCounts: canonical.receipt.canonicalInventory!.rowCounts,
          }
        : {
            kind: persistedEvidenceKind(source, false),
            originalSourceKind: source,
            objectId: `session:${attempt.sessionId}:source`,
            contentHash: null,
            byteSize: null,
            formatVersion: null,
            recordCounts: Object.fromEntries(inventory.outputs.map((entry) => [entry.name, entry.count])),
          },
    telemetryVersion: contract.telemetryVersion,
    analysisComponents: contract.analysisComponents,
    configuration: {
      hash: contract.configurationHash,
      effective: contract.effectiveConfiguration,
    },
    context: {
      gameId,
      trackId: String(session.trackOrdinal),
      layoutId: null,
      trackDefinitionHash: null,
      cornerDefinitionHash: null,
    },
    sourceFidelity: canonical?.receipt.sourceFidelity ?? {
      profileVersion: session.sourceChannelProfile?.schemaVersion ?? null,
      decisions: session.sourceChannelProfile
        ? Object.entries(session.sourceChannelProfile.channels)
            .map(([id, entry]) => `${id}:${entry?.treatment ?? "absent"}`)
            .sort()
        : [],
    },
    outputs: inventory.outputs,
    canonicalInventory: canonical?.receipt.canonicalInventory ?? null,
    warnings: raw
      ? []
      : canonical
        ? ["Rebuilt policy eligibility from verified canonical telemetry; native source bytes unavailable"]
        : ["Persisted source bytes unavailable for exact rebuild"],
    unsupportedFields: [],
    rebuildCapability: raw
      ? {
          mode: "exact" as const,
          sourceKind: persistedEvidenceKind(source, true),
          rebuildableArtifacts: [...SESSION_ANALYSIS_ARTIFACTS],
          unavailableArtifacts: [],
          limitations: [],
        }
      : canonical
        ? {
            mode: "limited" as const,
            sourceKind: "canonical-archive" as const,
            rebuildableArtifacts: [...SESSION_ANALYSIS_ARTIFACTS],
            unavailableArtifacts: [],
            limitations: ["Canonical telemetry cannot exactly re-decode game-native source frames"],
          }
        : {
            mode: "unavailable" as const,
            sourceKind: persistedEvidenceKind(source, false),
            rebuildableArtifacts: [],
            unavailableArtifacts: [...SESSION_ANALYSIS_ARTIFACTS],
            limitations: ["Source evidence unavailable"],
          },
    verification: completeVerification(inventory.checks, raw != null || canonical != null).map((check) =>
      canonical && check.id === "source_hash"
        ? { ...check, details: "Verified canonical archive output hash recorded" }
        : check,
    ),
    contractHash: contract.contractHash,
    startedAt: attempt.startedAt,
    completedAt: now,
    activatedAt: now,
  };
  const parsed = AnalysisProvenanceReceiptSchema.parse(receipt);
  if (parsed.verification.some((check) => check.status === "failed")) {
    throw new Error("Persisted session analysis failed output verification");
  }
  return parsed;
}

function safeFailure(code: AnalysisReceiptFailure["code"], message: string): AnalysisReceiptFailure {
  return {
    code,
    message,
    failedAt: new Date().toISOString(),
    checks: [{ id: "storage_state", status: "failed", details: message }],
  };
}

export async function activatePersistedSessionAnalysisReceipt(
  sessionId: number,
  gameId: GameId,
): Promise<AnalysisReceiptRow> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) throw new Error("Session not found");
  const contract = currentAnalysisContract(gameId, session.sourceChannelProfile ?? null);
  const raw = session.rawFile ? await inspectRawCaptureIdentity(session.rawFile) : undefined;
  const canonical = raw ? null : await loadVerifiedCanonicalArchiveEvidence(sessionId, gameId);
  const attempt = await beginAnalysisGeneration({
    sessionId,
    artifactSetType: "session_analysis",
    sourceContentHash: raw?.contentHash ?? canonical?.outputContentHash ?? null,
    contractHash: contract.contractHash,
    configurationHash: contract.configurationHash,
  });
  try {
    const receipt = await createPersistedSessionAnalysisReceipt(attempt, gameId, undefined, canonical);
    return await activateAnalysisGeneration({ generationId: attempt.generationId, receipt });
  } catch (error) {
    await failAnalysisGeneration(
      attempt.generationId,
      safeFailure("output_verification_failed", "Session analysis receipt verification failed"),
    );
    throw error;
  }
}

const REQUIRED_CANONICAL_CHECKS = [
  "source_hash",
  "schema_supported",
  "session_identity",
  "ordering",
  "coverage",
  "channel_inventory",
  "partitions_readable",
  "analyse_read",
  "compare_read",
  "storage_state",
] as const;

export function validateCanonicalArchiveReceipt(receiptInput: unknown): AnalysisProvenanceReceipt {
  const receipt = AnalysisProvenanceReceiptSchema.parse(receiptInput);
  if (receipt.artifactSetType !== "canonical_archive") throw new Error("Receipt is not a canonical archive receipt");
  if (!receipt.evidence.contentHash) throw new Error("Canonical archive source hash is required");
  const archiveOutput = receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
  if (!archiveOutput?.contentHash || archiveOutput.count < 1) throw new Error("Canonical archive output inventory is incomplete");
  if (!receipt.canonicalInventory || receipt.canonicalInventory.semanticIds.length === 0) {
    throw new Error("Canonical archive semantic channel inventory is required");
  }
  const checks = new Map(receipt.verification.map((check) => [check.id, check]));
  const required = receipt.participantId == null
    ? REQUIRED_CANONICAL_CHECKS
    : [...REQUIRED_CANONICAL_CHECKS, "participant_identity" as const];
  for (const id of required) {
    if (checks.get(id)?.status !== "passed") throw new Error(`Canonical archive verification check failed: ${id}`);
  }
  return receipt;
}
export interface ActivateCanonicalArchiveInput {
  sessionId: number;
  participantId?: string | null;
  sourceContentHash: string;
  contractHash: string;
  configurationHash: string;
  buildReceipt: (attempt: AnalysisReceiptRow) => Promise<AnalysisProvenanceReceipt>;
  beforeActivate?: (
    transaction: DbTransaction,
    attempt: AnalysisReceiptRow,
    receipt: AnalysisProvenanceReceipt,
  ) => Promise<void>;
}

export async function activateCanonicalArchiveReceipt(input: ActivateCanonicalArchiveInput): Promise<AnalysisReceiptRow> {
  const attempt = await beginAnalysisGeneration({
    sessionId: input.sessionId,
    participantId: input.participantId,
    artifactSetType: "canonical_archive",
    sourceContentHash: input.sourceContentHash,
    contractHash: input.contractHash,
    configurationHash: input.configurationHash,
  });
  try {
    const receipt = validateCanonicalArchiveReceipt(await input.buildReceipt(attempt));
    return await db.transaction(async (tx) => {
      await input.beforeActivate?.(tx, attempt, receipt);
      return activateAnalysisGeneration({ generationId: attempt.generationId, receipt }, tx);
    });
  } catch (error) {
    await failAnalysisGeneration(
      attempt.generationId,
      safeFailure("output_verification_failed", "Canonical archive receipt verification failed"),
    );
    throw error;
  }
}
