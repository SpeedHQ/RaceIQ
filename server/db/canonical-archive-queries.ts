import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { CanonicalArchiveNode } from "../../shared/racing/archives/contracts";
import { getActiveAnalysisReceipt } from "./analysis-receipt-queries";
import { db } from "./index";
import type { DbTransaction } from "./analysis-receipt-queries";
import {
  canonicalArchiveJobs,
  canonicalArchiveNodes,
  canonicalArchives,
} from "./schema";

export type CanonicalArchiveRow = typeof canonicalArchives.$inferSelect;
export type CanonicalArchiveJobRow = typeof canonicalArchiveJobs.$inferSelect;
export type CanonicalArchiveNodeRow = typeof canonicalArchiveNodes.$inferSelect;

type ArchiveClient = typeof db | DbTransaction;

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
    nextAttemptAt: input.nextAttemptAt ?? now,
    generationId: input.generationId ?? null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({
    target: [canonicalArchiveJobs.sessionId, canonicalArchiveJobs.sourceContentHash],
  });
  const row = await db.select().from(canonicalArchiveJobs).where(eq(canonicalArchiveJobs.jobId, jobId)).get();
  if (!row) throw new Error("Canonical archive job was not persisted");
  return row;
}

export async function recoverExpiredCanonicalArchiveJobs(now = nowIso()): Promise<number> {
  const result = await db.update(canonicalArchiveJobs).set({
    status: "pending",
    leaseExpiresAt: null,
    nextAttemptAt: now,
    updatedAt: now,
  }).where(and(
    eq(canonicalArchiveJobs.status, "running"),
    lte(canonicalArchiveJobs.leaseExpiresAt, now),
  ));
  return Number(result.rowsAffected ?? 0);
}

export async function claimCanonicalArchiveJob(input: {
  leaseMs?: number;
  now?: string;
} = {}): Promise<CanonicalArchiveJobRow | null> {
  const now = input.now ?? nowIso();
  const leaseExpiresAt = new Date(Date.parse(now) + (input.leaseMs ?? 60_000)).toISOString();
  return db.transaction(async (tx) => {
    await tx.update(canonicalArchiveJobs).set({
      status: "pending",
      leaseExpiresAt: null,
      nextAttemptAt: now,
      updatedAt: now,
    }).where(and(
      eq(canonicalArchiveJobs.status, "running"),
      lte(canonicalArchiveJobs.leaseExpiresAt, now),
    ));
    const candidate = await tx.select().from(canonicalArchiveJobs).where(and(
      eq(canonicalArchiveJobs.status, "pending"),
      lte(canonicalArchiveJobs.nextAttemptAt, now),
    )).orderBy(asc(canonicalArchiveJobs.nextAttemptAt), asc(canonicalArchiveJobs.createdAt)).limit(1).get();
    if (!candidate) return null;
    const claimed = await tx.update(canonicalArchiveJobs).set({
      status: "running",
      attemptCount: sql`${canonicalArchiveJobs.attemptCount} + 1`,
      leaseExpiresAt,
      updatedAt: now,
    }).where(and(
      eq(canonicalArchiveJobs.jobId, candidate.jobId),
      eq(canonicalArchiveJobs.status, "pending"),
    )).returning();
    return claimed[0] ?? null;
  });
}

export async function heartbeatCanonicalArchiveJob(jobId: string, leaseMs = 60_000): Promise<CanonicalArchiveJobRow | null> {
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
  const rows = await db.update(canonicalArchiveJobs).set({ leaseExpiresAt, updatedAt: now })
    .where(and(eq(canonicalArchiveJobs.jobId, jobId), eq(canonicalArchiveJobs.status, "running")))
    .returning();
  return rows[0] ?? null;
}

export async function completeCanonicalArchiveJob(jobId: string, generationId?: string | null): Promise<CanonicalArchiveJobRow | null> {
  const now = nowIso();
  const rows = await db.update(canonicalArchiveJobs).set({
    status: "succeeded",
    leaseExpiresAt: null,
    generationId: generationId ?? undefined,
    lastError: null,
    updatedAt: now,
  }).where(and(eq(canonicalArchiveJobs.jobId, jobId), eq(canonicalArchiveJobs.status, "running"))).returning();
  return rows[0] ?? null;
}

export async function failCanonicalArchiveJob(input: {
  jobId: string;
  error: string;
  retryAt?: string | null;
  deterministic?: boolean;
}): Promise<CanonicalArchiveJobRow | null> {
  const now = nowIso();
  const retry = !input.deterministic && input.retryAt != null;
  const rows = await db.update(canonicalArchiveJobs).set({
    status: retry ? "pending" : "failed",
    leaseExpiresAt: null,
    nextAttemptAt: input.retryAt ?? now,
    lastError: input.error,
    updatedAt: now,
  }).where(and(eq(canonicalArchiveJobs.jobId, input.jobId), eq(canonicalArchiveJobs.status, "running"))).returning();
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
  const archive = await getActiveVerifiedCanonicalArchive(input.sessionId);
  if (!archive) return [];
  return db.select().from(canonicalArchiveNodes).where(and(
    eq(canonicalArchiveNodes.archiveId, archive.archiveId),
    input.lapId == null ? undefined : eq(canonicalArchiveNodes.lapId, input.lapId),
  )).orderBy(asc(canonicalArchiveNodes.startRow), asc(canonicalArchiveNodes.ordinal));
}

export async function getActiveVerifiedCanonicalArchive(sessionId: number): Promise<CanonicalArchiveRow | null> {
  const active = await getActiveAnalysisReceipt({ sessionId, artifactSetType: "canonical_archive" });
  if (!active?.receipt) return null;
  const archiveId = active.receipt.evidence.objectId;
  const output = active.receipt.outputs.find((entry) => entry.artifactType === "canonical_archive");
  if (!output?.contentHash || !active.receipt.evidence.contentHash) return null;
  const archive = await db.select().from(canonicalArchives).where(and(
    eq(canonicalArchives.archiveId, archiveId),
    eq(canonicalArchives.sessionId, sessionId),
    inArray(canonicalArchives.status, ["verified", "partial"]),
    eq(canonicalArchives.generationId, active.receipt.generationId),
    eq(canonicalArchives.sourceContentHash, active.receipt.evidence.contentHash),
    eq(canonicalArchives.outputContentHash, output.contentHash),
  )).get();
  if (!archive) return null;
  const file = Bun.file(archive.archivePath);
  if (!(await file.exists())) return null;
  const hash = `sha256:${createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex")}`;
  return hash === archive.outputContentHash ? archive : null;
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
