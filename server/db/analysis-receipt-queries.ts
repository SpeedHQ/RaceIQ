import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";

import { canonicalJson } from "../../shared/core/canonical-json";
import {
  ANALYSIS_ARTIFACT_SET_IDENTITY_SEED,
  ANALYSIS_RECEIPT_SCHEMA_VERSION,
  AnalysisProvenanceReceiptSchema,
  AnalysisReceiptFailureSchema,
  type AnalysisArtifactSetType,
  type AnalysisProvenanceReceipt,
  type AnalysisReceiptFailure,
} from "../../shared/racing/provenance/contracts";
import { db } from "./index";
import {
  analysisReceipts,
  laps,
  raceEvents,
  sessionResults,
  sessionRuns,
  sessions,
} from "./schema";
import {
  analysisConfigurationHash,
  analysisContractHash,
} from "../analysis-provenance/hash";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type AnalysisReceiptRow = typeof analysisReceipts.$inferSelect;

type ReceiptClient = typeof db | DbTransaction;

export class AnalysisGenerationConflictError extends Error {
  readonly code = "analysis_generation_conflict" as const;
  readonly artifactSetId: string;

  constructor(artifactSetId: string) {
    super("Analysis rebuild already in progress for this artifact set");
    this.name = "AnalysisGenerationConflictError";
    this.artifactSetId = artifactSetId;
  }
}

function sha256Identity(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function deriveAnalysisArtifactSetId(input: {
  sessionId: number;
  participantId: string | null;
  artifactSetType: AnalysisArtifactSetType;
}): string {
  return `analysis-set:${sha256Identity([
    ANALYSIS_ARTIFACT_SET_IDENTITY_SEED,
    input.sessionId,
    input.participantId,
    input.artifactSetType,
  ]).slice("sha256:".length)}`;
}

export function deriveAnalysisGenerationId(artifactSetId: string, generation: number): string {
  return `analysis-generation:${sha256Identity([artifactSetId, generation]).slice("sha256:".length)}`;
}

export interface BeginAnalysisGenerationInput {
  sessionId: number;
  participantId?: string | null;
  artifactSetType: AnalysisArtifactSetType;
  sourceContentHash?: string | null;
  contractHash: string;
  configurationHash: string;
  startedAt?: string;
}

async function beginWithClient(
  client: ReceiptClient,
  input: BeginAnalysisGenerationInput,
): Promise<AnalysisReceiptRow> {
  const participantId = input.participantId ?? null;
  const artifactSetId = deriveAnalysisArtifactSetId({
    sessionId: input.sessionId,
    participantId,
    artifactSetType: input.artifactSetType,
  });
  const [latest] = await client
    .select({ generation: analysisReceipts.generation })
    .from(analysisReceipts)
    .where(eq(analysisReceipts.artifactSetId, artifactSetId))
    .orderBy(desc(analysisReceipts.generation))
    .limit(1);
  const generation = (latest?.generation ?? 0) + 1;
  const generationId = deriveAnalysisGenerationId(artifactSetId, generation);

  try {
    const [row] = await client
      .insert(analysisReceipts)
      .values({
        generationId,
        artifactSetId,
        sessionId: input.sessionId,
        participantId,
        artifactSetType: input.artifactSetType,
        generation,
        receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
        lifecycle: "rebuild_in_progress",
        sourceContentHash: input.sourceContentHash ?? null,
        contractHash: input.contractHash,
        configurationHash: input.configurationHash,
        receipt: null,
        failure: null,
        startedAt: input.startedAt ?? new Date().toISOString(),
        completedAt: null,
        activatedAt: null,
      })
      .returning();
    if (!row) throw new Error("Analysis generation insert returned no row");
    return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT")) {
      throw new AnalysisGenerationConflictError(artifactSetId);
    }
    throw error;
  }
}

export async function beginAnalysisGeneration(
  input: BeginAnalysisGenerationInput,
  transaction?: DbTransaction,
): Promise<AnalysisReceiptRow> {
  if (transaction) return beginWithClient(transaction, input);
  return db.transaction((tx) => beginWithClient(tx, input));
}

export interface BindAnalysisGenerationSourceInput {
  generationId: string;
  sourceContentHash: string;
}

async function bindSourceWithClient(
  client: ReceiptClient,
  input: BindAnalysisGenerationSourceInput,
): Promise<AnalysisReceiptRow> {
  const [pending] = await client
    .select()
    .from(analysisReceipts)
    .where(and(
      eq(analysisReceipts.generationId, input.generationId),
      eq(analysisReceipts.lifecycle, "rebuild_in_progress"),
    ))
    .limit(1);
  if (!pending) throw new Error("Analysis generation is not in progress");
  if (pending.sourceContentHash != null && pending.sourceContentHash !== input.sourceContentHash) {
    throw new Error("Analysis generation source hash is already bound");
  }
  if (pending.sourceContentHash === input.sourceContentHash) return pending;

  const [bound] = await client
    .update(analysisReceipts)
    .set({ sourceContentHash: input.sourceContentHash })
    .where(and(
      eq(analysisReceipts.generationId, input.generationId),
      eq(analysisReceipts.lifecycle, "rebuild_in_progress"),
      isNull(analysisReceipts.sourceContentHash),
    ))
    .returning();
  if (!bound) throw new Error("Analysis generation source binding failed");
  return bound;
}

export async function bindAnalysisGenerationSource(
  input: BindAnalysisGenerationSourceInput,
  transaction?: DbTransaction,
): Promise<AnalysisReceiptRow> {
  if (transaction) return bindSourceWithClient(transaction, input);
  return db.transaction((tx) => bindSourceWithClient(tx, input));
}

export interface ActivateAnalysisGenerationInput {
  generationId: string;
  receipt: AnalysisProvenanceReceipt;
}

async function activateWithClient(
  tx: DbTransaction,
  input: ActivateAnalysisGenerationInput,
): Promise<AnalysisReceiptRow> {
  const [pending] = await tx
    .select()
    .from(analysisReceipts)
    .where(and(
      eq(analysisReceipts.generationId, input.generationId),
      eq(analysisReceipts.lifecycle, "rebuild_in_progress"),
    ))
    .limit(1);
  if (!pending) throw new Error("Analysis generation is not in progress");

  const activatedAt = input.receipt.activatedAt ?? new Date().toISOString();
  const completedAt = input.receipt.completedAt ?? activatedAt;
  const receipt = AnalysisProvenanceReceiptSchema.parse({
    ...input.receipt,
    generationId: pending.generationId,
    artifactSetId: pending.artifactSetId,
    artifactSetType: pending.artifactSetType,
    generation: pending.generation,
    sessionId: pending.sessionId,
    participantId: pending.participantId,
    lifecycle: "active",
    completedAt,
    activatedAt,
  });
  if (receipt.verification.some((check) => check.status === "failed")) {
    throw new Error("Analysis receipt contains failed verification checks");
  }
  if (pending.sourceContentHash !== receipt.evidence.contentHash) {
    throw new Error("Analysis receipt source hash does not match generation attempt");
  }
  if (receipt.receiptSchemaVersion !== pending.receiptSchemaVersion) {
    throw new Error("Analysis receipt schema does not match generation attempt");
  }
  if (pending.contractHash !== receipt.contractHash) {
    throw new Error("Analysis receipt contract hash does not match generation attempt");
  }
  if (pending.configurationHash !== receipt.configuration.hash) {
    throw new Error("Analysis receipt configuration hash does not match generation attempt");
  }
  if (receipt.contractHash !== analysisContractHash({
    receiptSchemaVersion: receipt.receiptSchemaVersion,
    telemetryVersion: receipt.telemetryVersion,
    analysisComponents: receipt.analysisComponents,
  })) {
    throw new Error("Analysis receipt contract hash does not match receipt content");
  }
  if (receipt.configuration.hash !== analysisConfigurationHash(receipt.configuration.effective)) {
    throw new Error("Analysis receipt configuration hash does not match receipt content");
  }

  await tx
    .update(analysisReceipts)
    .set({ lifecycle: "superseded" })
    .where(and(
      eq(analysisReceipts.artifactSetId, pending.artifactSetId),
      eq(analysisReceipts.lifecycle, "active"),
    ));

  if (pending.artifactSetType === "session_analysis") {
    await Promise.all([
      tx.update(sessions).set({ analysisGenerationId: pending.generationId }).where(eq(sessions.id, pending.sessionId)),
      tx.update(laps).set({ analysisGenerationId: pending.generationId }).where(eq(laps.sessionId, pending.sessionId)),
      tx.update(raceEvents).set({ analysisGenerationId: pending.generationId }).where(eq(raceEvents.sessionId, pending.sessionId)),
      tx.update(sessionRuns).set({ analysisGenerationId: pending.generationId }).where(eq(sessionRuns.sessionId, pending.sessionId)),
      tx.update(sessionResults).set({ analysisGenerationId: pending.generationId }).where(eq(sessionResults.sessionId, pending.sessionId)),
    ]);
  }

  const [activated] = await tx
    .update(analysisReceipts)
    .set({
      lifecycle: "active",
      sourceContentHash: receipt.evidence.contentHash,
      receipt,
      failure: null,
      completedAt,
      activatedAt,
    })
    .where(and(
      eq(analysisReceipts.generationId, pending.generationId),
      eq(analysisReceipts.lifecycle, "rebuild_in_progress"),
    ))
    .returning();
  if (!activated) throw new Error("Analysis generation activation failed");
  return activated;
}

export async function activateAnalysisGeneration(
  input: ActivateAnalysisGenerationInput,
  transaction?: DbTransaction,
): Promise<AnalysisReceiptRow> {
  if (transaction) return activateWithClient(transaction, input);
  return db.transaction((tx) => activateWithClient(tx, input));
}

export async function failAnalysisGeneration(
  generationId: string,
  failureInput: AnalysisReceiptFailure,
  transaction?: DbTransaction,
): Promise<AnalysisReceiptRow> {
  const failure = AnalysisReceiptFailureSchema.parse(failureInput);
  const client: ReceiptClient = transaction ?? db;
  const [failed] = await client
    .update(analysisReceipts)
    .set({
      lifecycle: "verification_failed",
      failure,
      receipt: null,
      completedAt: failure.failedAt,
      activatedAt: null,
    })
    .where(and(
      eq(analysisReceipts.generationId, generationId),
      eq(analysisReceipts.lifecycle, "rebuild_in_progress"),
    ))
    .returning();
  if (!failed) throw new Error("Analysis generation is not in progress");
  return failed;
}

export async function getActiveAnalysisReceipt(input: {
  sessionId: number;
  participantId?: string | null;
  artifactSetType: AnalysisArtifactSetType;
}): Promise<AnalysisReceiptRow | undefined> {
  const artifactSetId = deriveAnalysisArtifactSetId({
    sessionId: input.sessionId,
    participantId: input.participantId ?? null,
    artifactSetType: input.artifactSetType,
  });
  const [row] = await db
    .select()
    .from(analysisReceipts)
    .where(and(
      eq(analysisReceipts.artifactSetId, artifactSetId),
      eq(analysisReceipts.lifecycle, "active"),
    ))
    .limit(1);
  return row;
}

export async function getLatestAnalysisAttempt(input: {
  sessionId: number;
  participantId?: string | null;
  artifactSetType: AnalysisArtifactSetType;
}): Promise<AnalysisReceiptRow | undefined> {
  const artifactSetId = deriveAnalysisArtifactSetId({
    sessionId: input.sessionId,
    participantId: input.participantId ?? null,
    artifactSetType: input.artifactSetType,
  });
  const [row] = await db
    .select()
    .from(analysisReceipts)
    .where(eq(analysisReceipts.artifactSetId, artifactSetId))
    .orderBy(desc(analysisReceipts.generation))
    .limit(1);
  return row;
}

export async function failInterruptedAnalysisGenerations(): Promise<number> {
  const interrupted = await db
    .select({ generationId: analysisReceipts.generationId })
    .from(analysisReceipts)
    .where(eq(analysisReceipts.lifecycle, "rebuild_in_progress"));
  for (const row of interrupted) {
    const failedAt = new Date().toISOString();
    await failAnalysisGeneration(row.generationId, {
      code: "rebuild_interrupted",
      message: "Analysis rebuild was interrupted before activation",
      failedAt,
      checks: [{ id: "storage_state", status: "failed", details: "Rebuild did not reach atomic activation" }],
    });
  }
  return interrupted.length;
}
