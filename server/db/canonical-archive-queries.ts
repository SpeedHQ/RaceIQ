import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";

import type { GameId } from "../../shared/games/ids";
import {
  CANONICAL_ARCHIVE_ALGORITHM_VERSION,
  CANONICAL_ARCHIVE_SCHEMA_VERSION,
  type CanonicalArchiveNode,
} from "../../shared/racing/archives/contracts";
import { ANALYSIS_RECEIPT_SCHEMA_VERSION } from "../../shared/racing/provenance/contracts";
import {
  deriveAnalysisArtifactSetId,
  type DbTransaction,
} from "./analysis-receipt-queries";
import { currentAnalysisContract } from "../analysis-provenance/current-contract";
import { analysisContractHash } from "../analysis-provenance/hash";
import { db } from "./index";
import {
  analysisReceipts,
  canonicalArchiveJobs,
  canonicalArchiveNodes,
  canonicalArchives,
  sessions,
} from "./schema";

export type CanonicalArchiveRow = typeof canonicalArchives.$inferSelect;
export type CanonicalArchiveJobRow = typeof canonicalArchiveJobs.$inferSelect;
export type CanonicalArchiveNodeRow = typeof canonicalArchiveNodes.$inferSelect;

export interface CanonicalArchiveJobLease {
  jobId: string;
  leaseToken: string;
  sessionId?: number;
  sourceContentHash?: string;
}

type ArchiveClient = typeof db | DbTransaction;
interface ArchiveOutputVerification {
  byteSize: number;
  ctimeMs: number;
  mtimeMs: number;
  outputContentHash: string;
}

export const MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS = 3;

export interface CanonicalArchiveLapReadPlan {
  archiveId: string;
  generationId: string;
  archivePath: string;
  sourceContentHash: string;
  outputContentHash: string;
  lapId: number;
  participantId: string | null;
  ranges: CanonicalArchiveNodeRow[];
}

const archiveOutputVerificationCache = new Map<string, ArchiveOutputVerification>();

async function verifyArchiveOutput(
  archiveId: string,
  archivePath: string,
  byteSize: number,
  outputContentHash: string,
): Promise<boolean> {
  const before = await stat(archivePath).catch(() => null);
  if (!before || before.size !== byteSize) return false;
  const cached = archiveOutputVerificationCache.get(archiveId);
  if (
    cached?.byteSize === before.size
    && cached.ctimeMs === before.ctimeMs
    && cached.mtimeMs === before.mtimeMs
    && cached.outputContentHash === outputContentHash
  ) {
    return true;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  const after = await stat(archivePath).catch(() => null);
  if (
    !after
    || after.size !== before.size
    || after.ctimeMs !== before.ctimeMs
    || after.mtimeMs !== before.mtimeMs
  ) {
    return false;
  }
  const verified = `sha256:${hash.digest("hex")}` === outputContentHash;
  if (verified) {
    archiveOutputVerificationCache.set(archiveId, {
      byteSize: after.size,
      ctimeMs: after.ctimeMs,
      mtimeMs: after.mtimeMs,
      outputContentHash,
    });
  } else {
    archiveOutputVerificationCache.delete(archiveId);
  }
  return verified;
}


function nowIso(): string {
  return new Date().toISOString();
}

function jobIdFor(sessionId: number, sourceContentHash: string): string {
  return `canonical-archive-job:${sessionId}:${sourceContentHash}`;
}

export async function enqueueCanonicalArchiveJob(input: {
  sessionId: number;
  sourceContentHash: string;
  generationId?: string | null;
  nextAttemptAt?: string;
  retryTerminal?: boolean;
  rebuildSucceeded?: boolean;
}): Promise<CanonicalArchiveJobRow> {
  const now = nowIso();
  const jobId = jobIdFor(input.sessionId, input.sourceContentHash);
  await db.insert(canonicalArchiveJobs).values({
    jobId,
    sessionId: input.sessionId,
    sourceContentHash: input.sourceContentHash,
    status: "pending",
    attemptCount: 0,
    leaseExpiresAt: null,
    leaseToken: null,
    nextAttemptAt: input.nextAttemptAt ?? now,
    generationId: input.generationId ?? null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [canonicalArchiveJobs.sessionId, canonicalArchiveJobs.sourceContentHash],
    set: {
      status: "pending",
      attemptCount: 0,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: input.nextAttemptAt ?? now,
      generationId: input.generationId ?? null,
      lastError: null,
      updatedAt: now,
    },
    where: input.retryTerminal
      ? eq(canonicalArchiveJobs.status, "failed")
      : input.rebuildSucceeded
        ? eq(canonicalArchiveJobs.status, "succeeded")
        : sql`0`,
  });
  const row = await db.select().from(canonicalArchiveJobs).where(eq(canonicalArchiveJobs.jobId, jobId)).get();
  if (!row) throw new Error("Canonical archive job was not persisted");
  return row;
}

export async function recoverExpiredCanonicalArchiveJobs(now = nowIso()): Promise<number> {
  const result = await db.update(canonicalArchiveJobs).set({
    status: sql`CASE WHEN ${canonicalArchiveJobs.attemptCount} >= ${MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS} THEN 'failed' ELSE 'pending' END`,
    leaseExpiresAt: null,
    leaseToken: null,
    nextAttemptAt: now,
    lastError: sql`CASE WHEN ${canonicalArchiveJobs.attemptCount} >= ${MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS} THEN 'Maximum canonical archive attempts exhausted' ELSE ${canonicalArchiveJobs.lastError} END`,
    updatedAt: now,
  }).where(and(
    eq(canonicalArchiveJobs.status, "running"),
    lte(canonicalArchiveJobs.leaseExpiresAt, now),
  ));
  return Number(result.rowsAffected ?? 0);
}

export async function recoverInterruptedCanonicalArchives(): Promise<number> {
  const result = await db.update(canonicalArchives).set({
    status: "failed",
    failure: "Canonical archive build was interrupted before activation",
  }).where(eq(canonicalArchives.status, "building"));
  return Number(result.rowsAffected ?? 0);
}

export async function claimCanonicalArchiveJob(input: {
  jobId?: string;
  leaseMs?: number;
  now?: string;
} = {}): Promise<CanonicalArchiveJobRow | null> {
  const now = input.now ?? nowIso();
  const leaseExpiresAt = new Date(Date.parse(now) + (input.leaseMs ?? 60_000)).toISOString();
  const leaseToken = randomUUID();
  return db.transaction(async (tx) => {
    await recoverExpiredCanonicalArchiveJobsWithClient(tx, now);
    const candidate = await tx.select().from(canonicalArchiveJobs).where(and(
      eq(canonicalArchiveJobs.status, "pending"),
      input.jobId == null ? undefined : eq(canonicalArchiveJobs.jobId, input.jobId),
      lte(canonicalArchiveJobs.nextAttemptAt, now),
      sql`${canonicalArchiveJobs.attemptCount} < ${MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS}`,
    )).orderBy(asc(canonicalArchiveJobs.nextAttemptAt), asc(canonicalArchiveJobs.createdAt)).limit(1).get();
    if (!candidate) return null;
    const claimed = await tx.update(canonicalArchiveJobs).set({
      status: "running",
      attemptCount: sql`${canonicalArchiveJobs.attemptCount} + 1`,
      leaseExpiresAt,
      leaseToken,
      updatedAt: now,
    }).where(and(
      eq(canonicalArchiveJobs.jobId, candidate.jobId),
      eq(canonicalArchiveJobs.status, "pending"),
      sql`${canonicalArchiveJobs.attemptCount} < ${MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS}`,
    )).returning();
    return claimed[0] ?? null;
  });
}

async function recoverExpiredCanonicalArchiveJobsWithClient(client: ArchiveClient, now: string): Promise<void> {
  await client.update(canonicalArchiveJobs).set({
    status: sql`CASE WHEN ${canonicalArchiveJobs.attemptCount} >= ${MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS} THEN 'failed' ELSE 'pending' END`,
    leaseExpiresAt: null,
    leaseToken: null,
    nextAttemptAt: now,
    lastError: sql`CASE WHEN ${canonicalArchiveJobs.attemptCount} >= ${MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS} THEN 'Maximum canonical archive attempts exhausted' ELSE ${canonicalArchiveJobs.lastError} END`,
    updatedAt: now,
  }).where(and(
    eq(canonicalArchiveJobs.status, "running"),
    lte(canonicalArchiveJobs.leaseExpiresAt, now),
  ));
}

export async function assertCanonicalArchiveJobLease(
  lease: CanonicalArchiveJobLease,
  transaction?: DbTransaction,
): Promise<void> {
  const client: ArchiveClient = transaction ?? db;
  const now = nowIso();
  const job = await client.select({ jobId: canonicalArchiveJobs.jobId })
    .from(canonicalArchiveJobs)
    .where(and(
      eq(canonicalArchiveJobs.jobId, lease.jobId),
      eq(canonicalArchiveJobs.status, "running"),
      eq(canonicalArchiveJobs.leaseToken, lease.leaseToken),
      lease.sessionId == null ? undefined : eq(canonicalArchiveJobs.sessionId, lease.sessionId),
      lease.sourceContentHash == null ? undefined : eq(canonicalArchiveJobs.sourceContentHash, lease.sourceContentHash),
      gt(canonicalArchiveJobs.leaseExpiresAt, now),
    ))
    .get();
  if (!job) throw new Error("Canonical archive job lease lost");
}

export async function heartbeatCanonicalArchiveJob(input: {
  jobId: string;
  leaseToken: string;
  leaseMs?: number;
}): Promise<CanonicalArchiveJobRow | null> {
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + (input.leaseMs ?? 60_000)).toISOString();
  const rows = await db.update(canonicalArchiveJobs).set({ leaseExpiresAt, updatedAt: now })
    .where(and(
      eq(canonicalArchiveJobs.jobId, input.jobId),
      eq(canonicalArchiveJobs.status, "running"),
      eq(canonicalArchiveJobs.leaseToken, input.leaseToken),
      gt(canonicalArchiveJobs.leaseExpiresAt, now),
    ))
    .returning();
  return rows[0] ?? null;
}

export async function completeCanonicalArchiveJob(input: {
  jobId: string;
  leaseToken: string;
  generationId?: string | null;
}): Promise<CanonicalArchiveJobRow | null> {
  const now = nowIso();
  const rows = await db.update(canonicalArchiveJobs).set({
    status: "succeeded",
    leaseExpiresAt: null,
    leaseToken: null,
    generationId: input.generationId ?? undefined,
    lastError: null,
    updatedAt: now,
  }).where(and(
    eq(canonicalArchiveJobs.jobId, input.jobId),
    eq(canonicalArchiveJobs.status, "running"),
    eq(canonicalArchiveJobs.leaseToken, input.leaseToken),
    gt(canonicalArchiveJobs.leaseExpiresAt, now),
  )).returning();
  return rows[0] ?? null;
}

export async function failCanonicalArchiveJob(input: {
  jobId: string;
  leaseToken: string;
  error: string;
  retryAt?: string | null;
  deterministic?: boolean;
}): Promise<CanonicalArchiveJobRow | null> {
  const now = nowIso();
  const retry = !input.deterministic && input.retryAt != null;
  const rows = await db.update(canonicalArchiveJobs).set({
    status: retry
      ? sql`CASE WHEN ${canonicalArchiveJobs.attemptCount} >= ${MAX_CANONICAL_ARCHIVE_JOB_ATTEMPTS} THEN 'failed' ELSE 'pending' END`
      : "failed",
    leaseExpiresAt: null,
    leaseToken: null,
    nextAttemptAt: input.retryAt ?? now,
    lastError: input.error,
    updatedAt: now,
  }).where(and(
    eq(canonicalArchiveJobs.jobId, input.jobId),
    eq(canonicalArchiveJobs.status, "running"),
    eq(canonicalArchiveJobs.leaseToken, input.leaseToken),
    gt(canonicalArchiveJobs.leaseExpiresAt, now),
  )).returning();
  return rows[0] ?? null;
}

export async function insertCanonicalArchiveNodes(
  archiveId: string,
  nodes: readonly CanonicalArchiveNode[],
  transaction?: DbTransaction,
): Promise<void> {
  if (nodes.length === 0) return;
  const client: ArchiveClient = transaction ?? db;
  await client.insert(canonicalArchiveNodes).values(nodes.map((node) => ({
    nodeId: node.nodeId,
    archiveId,
    parentNodeId: node.parentNodeId,
    level: node.level,
    semanticKind: node.semanticKind,
    stableKey: node.stableKey,
    ordinal: node.ordinal,
    participantId: node.participantId,
    sessionRunId: node.sessionRunId,
    lapId: node.lapId,
    startRow: node.startRow,
    endRow: node.endRow,
    startSourceTimeMs: node.startSourceTimeMs,
    endSourceTimeMs: node.endSourceTimeMs,
    startTrackDistanceM: node.startTrackDistanceM,
    endTrackDistanceM: node.endTrackDistanceM,
    status: node.status,
    definitionHash: node.definitionHash,
    boundaryAlgorithmVersion: node.boundaryAlgorithmVersion,
  })));
}

export async function getCanonicalArchiveForSession(sessionId: number, sourceContentHash?: string): Promise<CanonicalArchiveRow | null> {
  const rows = await db.select().from(canonicalArchives).where(and(
    eq(canonicalArchives.sessionId, sessionId),
    sourceContentHash ? eq(canonicalArchives.sourceContentHash, sourceContentHash) : sql`${canonicalArchives.status} IN ('verified', 'partial')`,
  )).orderBy(desc(canonicalArchives.createdAt)).limit(1);
  return rows[0] ?? null;
}

export async function getCanonicalArchiveNodes(archiveId: string, levels?: readonly string[]): Promise<CanonicalArchiveNodeRow[]> {
  return db.select().from(canonicalArchiveNodes).where(and(
    eq(canonicalArchiveNodes.archiveId, archiveId),
    levels && levels.length > 0 ? inArray(canonicalArchiveNodes.level, [...levels]) : undefined,
  )).orderBy(asc(canonicalArchiveNodes.startRow), asc(canonicalArchiveNodes.ordinal));
}

export async function getCanonicalArchiveRowRanges(input: {
  sessionId: number;
  lapId?: number;
}): Promise<CanonicalArchiveNodeRow[]> {
  if (input.lapId != null) {
    return (await getCanonicalArchiveLapReadPlan({
      sessionId: input.sessionId,
      lapId: input.lapId,
    }))?.ranges ?? [];
  }
  return db.transaction(async (tx) => {
    const archive = await getCurrentVerifiedArchiveWithClient(tx, input.sessionId);
    if (!archive) return [];
    return tx.select().from(canonicalArchiveNodes).where(eq(canonicalArchiveNodes.archiveId, archive.archiveId))
      .orderBy(asc(canonicalArchiveNodes.startRow), asc(canonicalArchiveNodes.ordinal));
  });
}

async function getCurrentVerifiedArchiveWithClient(
  client: ArchiveClient,
  sessionId: number,
): Promise<CanonicalArchiveRow | null> {
  const session = await client.select({
    gameId: sessions.gameId,
    sourceChannelProfile: sessions.sourceChannelProfile,
  }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) return null;

  const artifactSetId = deriveAnalysisArtifactSetId({
    sessionId,
    participantId: null,
    artifactSetType: "canonical_archive",
  });
  const active = await client.select().from(analysisReceipts).where(and(
    eq(analysisReceipts.artifactSetId, artifactSetId),
    eq(analysisReceipts.lifecycle, "active"),
  )).get();
  if (!active?.receipt) return null;

  const archive = await client.select().from(canonicalArchives).where(and(
    eq(canonicalArchives.generationId, active.generationId),
    eq(canonicalArchives.sessionId, sessionId),
    inArray(canonicalArchives.status, ["verified", "partial"]),
  )).get();
  if (!archive) return null;

  const current = currentAnalysisContract(session.gameId as GameId, session.sourceChannelProfile);
  const output = active.receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
  const expectedContractHash = analysisContractHash({
    receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
    telemetryVersion: current.telemetryVersion,
    analysisComponents: [
      ...current.analysisComponents,
      {
        id: "canonical-archive",
        version: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
        schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  });
  const compatible =
    archive.schemaVersion === CANONICAL_ARCHIVE_SCHEMA_VERSION
    && archive.algorithmVersion === CANONICAL_ARCHIVE_ALGORITHM_VERSION
    && archive.generationId === active.receipt.generationId
    && archive.outputContentHash != null
    && archive.outputContentHash === output?.contentHash
    && archive.sourceContentHash === active.sourceContentHash
    && archive.sourceContentHash === active.receipt.evidence.contentHash
    && archive.manifest.sourceContentHash === archive.sourceContentHash
    && active.contractHash === expectedContractHash
    && active.configurationHash === current.configurationHash
    && active.receipt.contractHash === expectedContractHash
    && active.receipt.configuration.hash === current.configurationHash;
  if (compatible) return archive;

  await client.update(canonicalArchives).set({
    status: "superseded",
    failure: "Canonical archive no longer matches current schema, algorithm, contract, or configuration",
  }).where(and(
    eq(canonicalArchives.archiveId, archive.archiveId),
    inArray(canonicalArchives.status, ["verified", "partial"]),
  ));
  return null;
}

export async function getActiveVerifiedCanonicalArchive(
  sessionId: number,
  options: { verifyOutput?: boolean } = {},
): Promise<CanonicalArchiveRow | null> {
  const archive = await db.transaction((tx) => getCurrentVerifiedArchiveWithClient(tx, sessionId));
  if (!archive || archive.byteSize == null || !archive.outputContentHash) return null;
  const file = Bun.file(archive.archivePath);
  if (!(await file.exists()) || file.size !== archive.byteSize) return null;
  if (!options.verifyOutput) return archive;
  return await verifyArchiveOutput(
    archive.archiveId,
    archive.archivePath,
    archive.byteSize,
    archive.outputContentHash,
  )
    ? archive
    : null;
}

export async function getCanonicalArchiveLapReadPlan(input: {
  sessionId: number;
  lapId: number;
  participantId?: string;
}): Promise<CanonicalArchiveLapReadPlan | null> {
  const artifactSetId = deriveAnalysisArtifactSetId({
    sessionId: input.sessionId,
    participantId: null,
    artifactSetType: "canonical_archive",
  });
  const snapshot = await db.select({
    archive: canonicalArchives,
    active: analysisReceipts,
    gameId: sessions.gameId,
    sourceChannelProfile: sessions.sourceChannelProfile,
    node: canonicalArchiveNodes,
  }).from(canonicalArchives)
    .innerJoin(analysisReceipts, and(
      eq(canonicalArchives.generationId, analysisReceipts.generationId),
      eq(canonicalArchives.sessionId, analysisReceipts.sessionId),
      eq(analysisReceipts.artifactSetId, artifactSetId),
      eq(analysisReceipts.lifecycle, "active"),
    ))
    .innerJoin(sessions, eq(sessions.id, canonicalArchives.sessionId))
    .leftJoin(canonicalArchiveNodes, and(
      eq(canonicalArchiveNodes.archiveId, canonicalArchives.archiveId),
      eq(canonicalArchiveNodes.lapId, input.lapId),
      input.participantId == null ? undefined : eq(canonicalArchiveNodes.participantId, input.participantId),
    ))
    .where(and(
      eq(canonicalArchives.sessionId, input.sessionId),
      inArray(canonicalArchives.status, ["verified", "partial"]),
    ))
    .orderBy(asc(canonicalArchiveNodes.startRow), asc(canonicalArchiveNodes.ordinal));
  const active = snapshot[0]?.active;
  if (!active?.receipt) return null;
  const rows = snapshot;
  const first = rows[0];
  if (!first || first.archive.outputContentHash == null) return null;

  const current = currentAnalysisContract(first.gameId as GameId, first.sourceChannelProfile);
  const output = active.receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
  const expectedContractHash = analysisContractHash({
    receiptSchemaVersion: ANALYSIS_RECEIPT_SCHEMA_VERSION,
    telemetryVersion: current.telemetryVersion,
    analysisComponents: [
      ...current.analysisComponents,
      {
        id: "canonical-archive",
        version: CANONICAL_ARCHIVE_ALGORITHM_VERSION,
        schemaVersion: CANONICAL_ARCHIVE_SCHEMA_VERSION,
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  });
  const compatible =
    first.archive.schemaVersion === CANONICAL_ARCHIVE_SCHEMA_VERSION
    && first.archive.algorithmVersion === CANONICAL_ARCHIVE_ALGORITHM_VERSION
    && first.archive.generationId === active.receipt.generationId
    && first.archive.outputContentHash === output?.contentHash
    && first.archive.sourceContentHash === active.sourceContentHash
    && first.archive.sourceContentHash === active.receipt.evidence.contentHash
    && first.archive.manifest.sourceContentHash === first.archive.sourceContentHash
    && active.contractHash === expectedContractHash
    && active.configurationHash === current.configurationHash
    && active.receipt.contractHash === expectedContractHash
    && active.receipt.configuration.hash === current.configurationHash;
  if (!compatible) {
    await db.update(canonicalArchives).set({
      status: "superseded",
      failure: "Canonical archive no longer matches current schema, algorithm, contract, or configuration",
    }).where(and(
      eq(canonicalArchives.archiveId, first.archive.archiveId),
      inArray(canonicalArchives.status, ["verified", "partial"]),
    ));
    return null;
  }

  const ranges = rows.flatMap((row) => row.node == null ? [] : [row.node]);
  if (ranges.length === 0) return null;
  return {
    archiveId: first.archive.archiveId,
    generationId: first.archive.generationId,
    archivePath: first.archive.archivePath,
    sourceContentHash: first.archive.sourceContentHash,
    outputContentHash: first.archive.outputContentHash,
    lapId: input.lapId,
    participantId: input.participantId ?? null,
    ranges,
  };
}

export async function getCanonicalArchiveSampleRows(input: {
  sessionId: number;
  startRow: number;
  endRow: number;
}): Promise<{ archivePath: string; startRow: number; endRow: number } | null> {
  const archive = await getActiveVerifiedCanonicalArchive(input.sessionId);
  if (!archive || input.startRow < 0 || input.endRow < input.startRow || input.endRow > archive.sampleCount) return null;
  return { archivePath: archive.archivePath, startRow: input.startRow, endRow: input.endRow };
}

export async function listCanonicalArchiveJobs(sessionId?: number): Promise<CanonicalArchiveJobRow[]> {
  return db.select().from(canonicalArchiveJobs)
    .where(sessionId == null ? undefined : eq(canonicalArchiveJobs.sessionId, sessionId))
    .orderBy(desc(canonicalArchiveJobs.updatedAt));
}
