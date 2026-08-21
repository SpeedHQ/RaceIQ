import { eq } from "drizzle-orm";
import type { GameId } from "../../shared/games/ids";
import { inspectRawCaptureIdentity } from "../session-capture/identity";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type RecordingQualitySummary,
  type SourceChannelProfile,
} from "../../shared/racing/quality/contracts";
import {
  AnalysisProvenanceReceiptSchema,
  type AnalysisRebuildPreview,
  type AnalysisReceiptSummary,
  type AnalysisStaleReason,
  type AnalysisStatus,
} from "../../shared/racing/provenance/contracts";
import { auditPersistedSessionAnalysis } from "../analysis-provenance/inventory";
import {
  createPersistedSessionAnalysisReceipt,
  loadVerifiedCanonicalArchiveEvidence,
} from "../analysis-provenance/receipt";
import { currentAnalysisContract } from "../analysis-provenance/current-contract";
import { analysisCanonicalHash } from "../analysis-provenance/hash";
import {
  activateAnalysisGeneration,
  beginAnalysisGeneration,
  failAnalysisGeneration,
  getActiveAnalysisReceipt,
  getLatestAnalysisAttempt,
  type AnalysisReceiptRow,
} from "../db/analysis-receipt-queries";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { updateSessionQuality } from "../db/session-queries";
import { tryGetServerGame } from "../games/registry";
import { getSessionCanonicalAvailability } from "./canonical-archive-availability";

export type QualityRebuildAction = "current" | "rebuild_eligibility" | "reprocess" | "rebuild_in_progress" | "unavailable";

export interface QualityRebuildStatus {
  sessionId: number;
  action: QualityRebuildAction;
  currentDetectorId: string | null;
  rawAvailable: boolean;
  lapCount: number;
  recordingQuality: RecordingQualitySummary | null;
  qualityGeneration: string | null;
  stale: {
    detector: boolean;
    schema: boolean;
    policy: boolean;
    configuration: boolean;
    source: boolean;
  };
  analysisStatus: AnalysisStatus;
}

interface SessionStatusRow {
  gameId: string;
  detectorVersion: string | null;
  rawFile: string | null;
  recordingQuality: RecordingQualitySummary | null;
  schemaVersion: string | null;
  policyVersion: string | null;
  configurationVersion: string | null;
  qualityGeneration: string | null;
  sourceChannelProfile: SourceChannelProfile | null;
}

function receiptSummary(row: AnalysisReceiptRow | undefined): AnalysisReceiptSummary | null {
  return row
    ? {
        generationId: row.generationId,
        generation: row.generation,
        lifecycle: row.lifecycle,
        receiptSchemaVersion: row.receiptSchemaVersion,
        completedAt: row.completedAt,
        activatedAt: row.activatedAt,
      }
    : null;
}

async function sourceState(session: SessionStatusRow) {
  if (!session.rawFile) return { rawAvailable: false, contentHash: null as string | null };
  try {
    const raw = await inspectRawCaptureIdentity(session.rawFile);
    return { rawAvailable: raw != null, contentHash: raw?.contentHash ?? null };
  } catch {
    return { rawAvailable: false, contentHash: null as string | null };
  }
}

async function evaluateAnalysisStatus(
  sessionId: number,
  session: SessionStatusRow,
  rawAvailable: boolean,
  rawSourceIdentity: string | null,
  canonicalSourceIdentity: string | null,
  canonicalOutputIdentity: string | null,
): Promise<AnalysisStatus> {
  const [active, latest] = await Promise.all([
    getActiveAnalysisReceipt({ sessionId, artifactSetType: "session_analysis" }),
    getLatestAnalysisAttempt({ sessionId, artifactSetType: "session_analysis" }),
  ]);
  const sourceExecutorAvailable = tryGetServerGame(session.gameId) != null;
  const canonicalAvailable = canonicalOutputIdentity != null;
  const sourceCanRebuild = (rawAvailable || canonicalAvailable) && sourceExecutorAvailable;
  const exactCapability = {
    mode: "exact" as const,
    sourceKind: "raceiq-raw" as const,
    rebuildableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"] as const,
    unavailableArtifacts: [] as const,
    limitations: [] as string[],
  };
  const canonicalCapability = {
    mode: "limited" as const,
    sourceKind: "canonical-archive" as const,
    rebuildableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"] as const,
    unavailableArtifacts: [] as const,
    limitations: ["Canonical telemetry cannot exactly re-decode game-native source frames"],
  };
  const unavailableCapability = {
    mode: "unavailable" as const,
    sourceKind: "unknown" as const,
    rebuildableArtifacts: [] as const,
    unavailableArtifacts: ["laps", "race_events", "session_runs", "race_result", "quality"] as const,
    limitations: [sourceExecutorAvailable ? "Source evidence unavailable" : "No compatible source executor registered"],
  };
  const capability = rawAvailable
    ? { ...exactCapability, rebuildableArtifacts: [...exactCapability.rebuildableArtifacts], unavailableArtifacts: [] }
    : canonicalAvailable && sourceExecutorAvailable
      ? { ...canonicalCapability, rebuildableArtifacts: [...canonicalCapability.rebuildableArtifacts], unavailableArtifacts: [] }
      : { ...unavailableCapability, rebuildableArtifacts: [], unavailableArtifacts: [...unavailableCapability.unavailableArtifacts] };

  let receipt = null;
  let incompatible = false;
  if (active?.receipt) {
    const parsed = AnalysisProvenanceReceiptSchema.safeParse(active.receipt);
    incompatible = !parsed.success;
    receipt = parsed.success ? parsed.data : null;
  }
  const base = {
    activeGeneration: receiptSummary(active),
    latestAttempt: receiptSummary(latest),
    capability,
    receipt,
    failure: latest?.lifecycle === "verification_failed" ? latest.failure : null,
  };
  if (incompatible || (active && !receipt)) {
    return { ...base, status: "incompatible", staleReasons: ["receipt_schema_changed"] };
  }
  if (receipt) {
    const audit = await auditPersistedSessionAnalysis(receipt);
    if (audit.some((check) => check.status === "failed")) {
      return { ...base, status: "corrupt", staleReasons: ["output_verification_failed"] };
    }
  }
  if (latest?.lifecycle === "rebuild_in_progress") {
    return { ...base, status: "rebuild_in_progress", staleReasons: [] };
  }
  if (latest?.lifecycle === "verification_failed" && latest.generationId !== active?.generationId) {
    return {
      ...base,
      status: "verification_failed",
      staleReasons: latest.failure?.code === "rebuild_interrupted" ? ["rebuild_interrupted"] : ["output_verification_failed"],
    };
  }
  if (!receipt) {
    return {
      ...base,
      status: sourceCanRebuild ? "stale_rebuild_available" : "stale_source_missing",
      staleReasons: sourceCanRebuild ? ["receipt_missing"] : ["receipt_missing", "source_unavailable"],
    };
  }

  const contract = currentAnalysisContract(session.gameId as GameId, session.sourceChannelProfile);
  const staleReasons: AnalysisStaleReason[] = [];
  const receiptIdentity = receipt.evidence.kind === "canonical-archive"
    ? canonicalOutputIdentity
    : rawSourceIdentity ?? canonicalSourceIdentity;
  if (receiptIdentity && receipt.evidence.contentHash !== receiptIdentity) {
    staleReasons.push("source_hash_changed");
  }
  if (analysisCanonicalHash(receipt.telemetryVersion) !== analysisCanonicalHash(contract.telemetryVersion)) staleReasons.push("telemetry_contract_changed");
  const currentComponents = new Map(contract.analysisComponents.map((component) => [component.id, component]));
  for (const component of receipt.analysisComponents) {
    const current = currentComponents.get(component.id);
    if (!current || current.version !== component.version || current.schemaVersion !== component.schemaVersion) {
      staleReasons.push(component.id === "quality"
        ? "configuration_changed"
        : component.id.includes("detector") || component.id === "lap-timeline"
          ? "detector_changed"
          : "algorithm_changed");
    }
  }
  if (receipt.configuration.hash !== contract.configurationHash) staleReasons.push("configuration_changed");
  if (receipt.contractHash !== contract.contractHash && staleReasons.length === 0) staleReasons.push("telemetry_contract_changed");
  const uniqueReasons = [...new Set(staleReasons)];
  if (uniqueReasons.length > 0) {
    return {
      ...base,
      status: sourceCanRebuild ? "stale_rebuild_available" : "stale_source_missing",
      staleReasons: uniqueReasons,
    };
  }
  return { ...base, status: "current", staleReasons: [] };
}

function configurationWithoutQuality(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const { quality: _quality, ...configuration } = value as Record<string, unknown>;
  return configuration;
}

function isPolicyOnlyReceiptStaleness(
  analysisStatus: AnalysisStatus,
  policyStale: boolean,
  measurementStale: boolean,
  currentConfiguration: unknown,
): boolean {
  if (!policyStale || measurementStale || analysisStatus.status !== "stale_rebuild_available") return false;
  if (analysisStatus.staleReasons.length === 0 || analysisStatus.staleReasons.some((reason) => reason !== "configuration_changed")) return false;
  const receiptConfiguration = configurationWithoutQuality(analysisStatus.receipt?.configuration.effective);
  const currentNonQualityConfiguration = configurationWithoutQuality(currentConfiguration);
  return receiptConfiguration != null
    && currentNonQualityConfiguration != null
    && analysisCanonicalHash(receiptConfiguration) === analysisCanonicalHash(currentNonQualityConfiguration);
}

export async function getQualityRebuildStatus(sessionId: number): Promise<QualityRebuildStatus> {
  const session = await db
    .select({
      gameId: sessions.gameId,
      detectorVersion: sessions.lapDetectorVersion,
      rawFile: sessions.rawFile,
      recordingQuality: sessions.recordingQuality,
      schemaVersion: sessions.qualitySchemaVersion,
      policyVersion: sessions.qualityPolicyVersion,
      configurationVersion: sessions.qualityConfigVersion,
      qualityGeneration: sessions.qualityGeneration,
      sourceChannelProfile: sessions.sourceChannelProfile,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const lapRows = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, sessionId)).all();
  const [source, canonicalArchive] = await Promise.all([
    sourceState(session),
    getSessionCanonicalAvailability(sessionId),
  ]);
  const canonicalSourceIdentity = canonicalArchive?.state === "available"
    ? canonicalArchive.provenance?.sourceIdentity ?? null
    : null;
  const canonicalOutputIdentity = canonicalArchive?.state === "available"
    ? canonicalArchive.provenance?.outputIdentity ?? null
    : null;
  const sourceVerificationGeneration = session.recordingQuality?.archiveVerification.sourceGeneration ?? null;
  const canonicalVerificationGeneration = session.recordingQuality?.canonicalVerification?.sourceGeneration ?? null;
  const sourceIdentity = source.rawAvailable ? source.contentHash : canonicalSourceIdentity;
  const sourceStale = (
    sourceVerificationGeneration !== null
    && sourceIdentity !== null
    && sourceVerificationGeneration !== sourceIdentity
  ) || (
    canonicalVerificationGeneration !== null
    && canonicalOutputIdentity !== null
    && canonicalVerificationGeneration !== canonicalOutputIdentity
  );
  const currentDetectorId = tryGetServerGame(session.gameId)?.lapDetectorId ?? null;
  const stale = {
    detector: currentDetectorId === null || session.detectorVersion === null || session.detectorVersion !== currentDetectorId,
    schema: session.schemaVersion !== QUALITY_SCHEMA_VERSION,
    policy: session.policyVersion !== ELIGIBILITY_POLICY_VERSION,
    configuration: session.configurationVersion !== QUALITY_CONFIG_VERSION,
    source: sourceStale,
  };
  const analysisStatus = await evaluateAnalysisStatus(
    sessionId,
    session,
    source.rawAvailable,
    source.contentHash,
    canonicalSourceIdentity,
    canonicalOutputIdentity,
  );
  const measurementStale = !session.recordingQuality || stale.schema || stale.detector || stale.configuration || stale.source;
  const contract = currentAnalysisContract(session.gameId as GameId, session.sourceChannelProfile);
  const policyOnlyReceiptStaleness = isPolicyOnlyReceiptStaleness(
    analysisStatus,
    stale.policy,
    measurementStale,
    contract.effectiveConfiguration,
  );
  const missingReceiptWithoutMeasurementStaleness = analysisStatus.receipt == null
    && analysisStatus.staleReasons.includes("receipt_missing")
    && !measurementStale;
  const canonicalReceiptCanBeRebuilt = missingReceiptWithoutMeasurementStaleness
    && analysisStatus.capability.sourceKind === "canonical-archive";
  const receiptRequiresReprocess = analysisStatus.status !== "current"
    && analysisStatus.status !== "rebuild_in_progress"
    && !policyOnlyReceiptStaleness
    && !missingReceiptWithoutMeasurementStaleness;
  const receiptOnlyRebuild = policyOnlyReceiptStaleness || canonicalReceiptCanBeRebuilt;
  const action: QualityRebuildAction = analysisStatus.status === "rebuild_in_progress"
    ? "rebuild_in_progress"
    : measurementStale || receiptRequiresReprocess
      ? (analysisStatus.capability.mode !== "unavailable" && currentDetectorId !== null ? "reprocess" : "unavailable")
      : stale.policy || receiptOnlyRebuild
        ? "rebuild_eligibility"
        : "current";
  return {
    sessionId,
    currentDetectorId,
    action,
    rawAvailable: source.rawAvailable,
    lapCount: lapRows.length,
    recordingQuality: session.recordingQuality,
    qualityGeneration: session.qualityGeneration,
    stale,
    analysisStatus,
  };
}

export async function getAnalysisRebuildPreview(sessionId: number): Promise<AnalysisRebuildPreview> {
  const status = await getQualityRebuildStatus(sessionId);
  const outputsReplaced = status.analysisStatus.receipt?.outputs.map((entry) => entry.artifactType)
    ?? ["laps", "race_events", "session_runs", "race_result", "quality"];
  return {
    sessionId,
    status: status.analysisStatus,
    selectedSource: status.rawAvailable ? "raceiq-raw" : status.analysisStatus.capability.sourceKind,
    outputsReplaced,
    sourceAvailable: status.analysisStatus.capability.mode !== "unavailable",
    capability: status.analysisStatus.capability,
    limitations: status.analysisStatus.capability.limitations,
  };
}

export async function rebuildSessionEligibility(sessionId: number): Promise<QualityRebuildStatus> {
  const status = await getQualityRebuildStatus(sessionId);
  if (status.action === "current") return status;
  if (status.action !== "rebuild_eligibility") return status;
  const session = await db
    .select({
      gameId: sessions.gameId,
      sourceChannelProfile: sessions.sourceChannelProfile,
      rawFile: sessions.rawFile,
      recordingQuality: sessions.recordingQuality,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .get();
  if (!session?.recordingQuality) return { ...status, action: "unavailable" };
  const contract = currentAnalysisContract(session.gameId as GameId, session.sourceChannelProfile);
  const raw = session.rawFile ? await inspectRawCaptureIdentity(session.rawFile) : undefined;
  const canonicalEvidence = raw ? null : await loadVerifiedCanonicalArchiveEvidence(sessionId, session.gameId as GameId);
  const canonicalArchive = raw ? null : await getSessionCanonicalAvailability(sessionId);
  const canonicalOutputIdentity = canonicalArchive?.state === "available"
    ? canonicalArchive.provenance?.outputIdentity ?? null
    : null;
  const attempt = await beginAnalysisGeneration({
    sessionId,
    artifactSetType: "session_analysis",
    sourceContentHash: raw?.contentHash ?? canonicalOutputIdentity,
    contractHash: contract.contractHash,
    configurationHash: contract.configurationHash,
  });
  try {
    await db.transaction(async (tx) => {
      await updateSessionQuality(sessionId, session.recordingQuality!, tx);
      const receipt = await createPersistedSessionAnalysisReceipt(attempt, session.gameId as GameId, tx, canonicalEvidence);
      await activateAnalysisGeneration({ generationId: attempt.generationId, receipt }, tx);
    });
  } catch (error) {
    await failAnalysisGeneration(attempt.generationId, {
      code: "output_verification_failed",
      message: "Quality policy rebuild failed before activation",
      failedAt: new Date().toISOString(),
      checks: [{ id: "storage_state", status: "failed", details: "Quality policy rebuild did not activate a receipt" }],
    }).catch(() => {});
    throw error;
  }
  return getQualityRebuildStatus(sessionId);
}
