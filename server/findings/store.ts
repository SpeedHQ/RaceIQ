import { createHash } from "node:crypto";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "../db/index";
import { findingGenerations, findingRecords } from "../db/schema";
import { assertNoFindingConflicts, canonicalJson } from "../../shared/racing/findings/identity";
import { validateFinding } from "../../shared/racing/findings/validate";
import type {
  FindingGenerationReceipt,
  FindingGenerationStatus,
  FindingRecord,
  FindingScope,
} from "../../shared/racing/findings/types";

const ACTIVE_STATUSES = ["current", "stale-rebuild-available", "stale-source-missing"] as const;
export type ActiveFindingGenerationStatus = (typeof ACTIVE_STATUSES)[number];
export type StaleFindingGenerationStatus = Exclude<ActiveFindingGenerationStatus, "current">;

export interface FindingGenerationInput {
  scope: FindingScope;
  receipt: FindingGenerationReceipt;
  findings: readonly FindingRecord[];
}

export interface StoredFindingGeneration {
  scope: FindingScope;
  receipt: FindingGenerationReceipt;
  findings: FindingRecord[];
}

export class FindingGenerationVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingGenerationVerificationError";
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function structuredFindingJson(finding: FindingRecord): string {
  const { title: _prose, ...structured } = finding;
  return canonicalJson(structured);
}

export function findingGenerationContentHash(findings: readonly FindingRecord[]): string {
  const ordered = findings
    .map((finding) => ({ id: finding.id, structured: JSON.parse(structuredFindingJson(finding)) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return digest(canonicalJson(ordered));
}

export function findingGenerationCounts(findings: readonly FindingRecord[]): Pick<
  FindingGenerationReceipt,
  "findingCount" | "availableCount" | "unavailableCount" | "indeterminateCount"
> {
  return {
    findingCount: findings.length,
    availableCount: findings.filter((finding) => finding.status === "available").length,
    unavailableCount: findings.filter((finding) => finding.status === "unavailable").length,
    indeterminateCount: findings.filter((finding) => finding.status === "indeterminate").length,
  };
}

export function createFindingGenerationReceipt(
  input: Omit<
    FindingGenerationReceipt,
    | "status"
    | "findingCount"
    | "availableCount"
    | "unavailableCount"
    | "indeterminateCount"
    | "contentHash"
    | "activatedAt"
    | "staleAt"
    | "failureReason"
  >,
  findings: readonly FindingRecord[],
): FindingGenerationReceipt {
  return {
    ...input,
    status: "staging",
    ...findingGenerationCounts(findings),
    contentHash: findingGenerationContentHash(findings),
  };
}

function scopeKey(scope: FindingScope): string {
  return canonicalJson(scope);
}

function activeStatusExpression() {
  return or(...ACTIVE_STATUSES.map((status) => eq(findingGenerations.status, status)));
}

function verifyGeneration(input: FindingGenerationInput): void {
  const { receipt, findings } = input;
  if (receipt.status !== "staging") {
    throw new FindingGenerationVerificationError("New finding generation receipt must have staging status");
  }
  if (!receipt.generationId || !receipt.sourceId || !receipt.createdAt) {
    throw new FindingGenerationVerificationError("Finding generation receipt identity is incomplete");
  }

  canonicalJson(input.scope);
  canonicalJson(receipt.rule);
  canonicalJson(receipt.config);

  const ids = new Set<string>();
  const expectedScope = scopeKey(input.scope);
  for (const finding of findings) {
    if (ids.has(finding.id)) {
      throw new FindingGenerationVerificationError(`Duplicate finding ID in generation: ${finding.id}`);
    }
    ids.add(finding.id);
    if (scopeKey(finding.scope) !== expectedScope) {
      throw new FindingGenerationVerificationError(`Finding ${finding.id} belongs to a different semantic scope`);
    }
    if (finding.analysisGenerationId !== receipt.sourceId) {
      throw new FindingGenerationVerificationError(`Finding ${finding.id} source generation does not match receipt`);
    }
    if (finding.schemaVersion !== receipt.schemaVersion) {
      throw new FindingGenerationVerificationError(`Finding ${finding.id} schema version does not match receipt`);
    }
    canonicalJson(finding.rule);
    const validation = validateFinding(finding);
    if (!validation.valid) {
      throw new FindingGenerationVerificationError(
        `Finding ${finding.id} failed validation: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
      );
    }
  }
  assertNoFindingConflicts(findings);

  const counts = findingGenerationCounts(findings);
  for (const key of ["findingCount", "availableCount", "unavailableCount", "indeterminateCount"] as const) {
    if (receipt[key] !== counts[key]) {
      throw new FindingGenerationVerificationError(`Finding generation ${key} does not match staged records`);
    }
  }
  if (receipt.contentHash !== findingGenerationContentHash(findings)) {
    throw new FindingGenerationVerificationError("Finding generation content hash does not match staged records");
  }
}

type FindingsDatabase = Pick<typeof db, "select" | "insert" | "update" | "delete">;

async function assertNoStoredConflicts(
  database: FindingsDatabase,
  findings: readonly FindingRecord[],
): Promise<void> {
  if (findings.length === 0) return;
  const candidates = await database
    .select({ structured: findingRecords.structured })
    .from(findingRecords)
    .where(inArray(findingRecords.findingId, findings.map((finding) => finding.id)));
  const incoming = new Map(findings.map((finding) => [finding.id, finding]));
  for (const candidate of candidates) {
    const stored = JSON.parse(candidate.structured) as FindingRecord;
    const replacement = incoming.get(stored.id);
    if (replacement) assertNoFindingConflicts([stored, replacement]);
  }
}

function generationValues(input: FindingGenerationInput, status: FindingGenerationStatus, failureReason?: string) {
  const { receipt } = input;
  return {
    id: receipt.generationId,
    scopeKey: scopeKey(input.scope),
    scope: canonicalJson(input.scope),
    sourceId: receipt.sourceId,
    rule: canonicalJson(receipt.rule),
    config: canonicalJson(receipt.config),
    schemaVersion: receipt.schemaVersion,
    status,
    findingCount: receipt.findingCount,
    availableCount: receipt.availableCount,
    unavailableCount: receipt.unavailableCount,
    indeterminateCount: receipt.indeterminateCount,
    contentHash: receipt.contentHash,
    createdAt: receipt.createdAt,
    verifiedAt: status === "staging" ? new Date().toISOString() : null,
    activatedAt: receipt.activatedAt ?? null,
    staleAt: receipt.staleAt ?? null,
    failureReason: failureReason ?? receipt.failureReason ?? null,
  };
}

async function insertStagedGeneration(database: FindingsDatabase, input: FindingGenerationInput): Promise<void> {
  await database.insert(findingGenerations).values(generationValues(input, "staging"));
  if (input.findings.length > 0) {
    await database.insert(findingRecords).values(input.findings.map((finding) => {
      const structured = structuredFindingJson(finding);
      return {
        generationId: input.receipt.generationId,
        findingId: finding.id,
        type: finding.type,
        status: finding.status,
        structured,
        structuredHash: digest(structured),
      };
    }));
  }
}

async function persistVerificationFailure(input: FindingGenerationInput, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ scopeKey: findingGenerations.scopeKey, status: findingGenerations.status })
      .from(findingGenerations)
      .where(eq(findingGenerations.id, input.receipt.generationId))
      .get();
    if (
      existing &&
      (existing.scopeKey !== scopeKey(input.scope) ||
        ACTIVE_STATUSES.includes(existing.status as ActiveFindingGenerationStatus))
    ) return;
    if (existing) await tx.delete(findingGenerations).where(eq(findingGenerations.id, input.receipt.generationId));
    await tx.insert(findingGenerations).values(generationValues(input, "verification-failed", reason));
  });
}

export async function stageFindingGeneration(input: FindingGenerationInput): Promise<FindingGenerationReceipt> {
  try {
    verifyGeneration(input);
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ status: findingGenerations.status })
        .from(findingGenerations)
        .where(eq(findingGenerations.id, input.receipt.generationId))
        .get();
      if (existing && ACTIVE_STATUSES.includes(existing.status as ActiveFindingGenerationStatus)) {
        throw new FindingGenerationVerificationError("Cannot restage active generation; use replaceFindingGeneration");
      }
      await assertNoStoredConflicts(tx, input.findings);
      if (existing) await tx.delete(findingGenerations).where(eq(findingGenerations.id, input.receipt.generationId));
      await insertStagedGeneration(tx, input);
    });
    return input.receipt;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await persistVerificationFailure(input, reason);
    throw error;
  }
}

function receiptFromRow(row: typeof findingGenerations.$inferSelect): FindingGenerationReceipt {
  return {
    generationId: row.id,
    sourceId: row.sourceId,
    rule: JSON.parse(row.rule),
    config: JSON.parse(row.config),
    schemaVersion: row.schemaVersion as FindingGenerationReceipt["schemaVersion"],
    status: row.status,
    findingCount: row.findingCount,
    availableCount: row.availableCount,
    unavailableCount: row.unavailableCount,
    indeterminateCount: row.indeterminateCount,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
    ...(row.activatedAt ? { activatedAt: row.activatedAt } : {}),
    ...(row.staleAt ? { staleAt: row.staleAt } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  };
}

async function readGeneration(generationId: string): Promise<StoredFindingGeneration | null> {
  const generation = await db
    .select()
    .from(findingGenerations)
    .where(eq(findingGenerations.id, generationId))
    .get();
  if (!generation) return null;
  const records = await db
    .select({ structured: findingRecords.structured })
    .from(findingRecords)
    .where(eq(findingRecords.generationId, generationId))
    .orderBy(findingRecords.findingId);
  return {
    scope: JSON.parse(generation.scope),
    receipt: receiptFromRow(generation),
    findings: records.map((record) => JSON.parse(record.structured) as FindingRecord),
  };
}

export async function getFindingGeneration(generationId: string): Promise<StoredFindingGeneration | null> {
  return readGeneration(generationId);
}

export async function getCurrentFindingGeneration(scope: FindingScope): Promise<StoredFindingGeneration | null> {
  const generation = await db
    .select({ id: findingGenerations.id })
    .from(findingGenerations)
    .where(and(eq(findingGenerations.scopeKey, scopeKey(scope)), activeStatusExpression()))
    .get();
  return generation ? readGeneration(generation.id) : null;
}

export async function activateFindingGeneration(generationId: string): Promise<FindingGenerationReceipt> {
  try {
    return await db.transaction(async (tx) => {
      const generation = await tx
        .select()
        .from(findingGenerations)
        .where(eq(findingGenerations.id, generationId))
        .get();
      if (!generation || generation.status !== "staging") {
        throw new FindingGenerationVerificationError("Only staged finding generations can be activated");
      }
      const records = await tx
        .select({ structured: findingRecords.structured })
        .from(findingRecords)
        .where(eq(findingRecords.generationId, generationId));
      const findings = records.map((record) => JSON.parse(record.structured) as FindingRecord);
      const counts = findingGenerationCounts(findings);
      if (
        counts.findingCount !== generation.findingCount ||
        counts.availableCount !== generation.availableCount ||
        counts.unavailableCount !== generation.unavailableCount ||
        counts.indeterminateCount !== generation.indeterminateCount ||
        findingGenerationContentHash(findings) !== generation.contentHash
      ) {
        throw new FindingGenerationVerificationError("Staged finding generation failed stored count/hash verification");
      }
      await assertNoStoredConflicts(tx, findings);
      await tx
        .delete(findingGenerations)
        .where(and(eq(findingGenerations.scopeKey, generation.scopeKey), ne(findingGenerations.id, generationId), activeStatusExpression()));
      const activatedAt = new Date().toISOString();
      await tx
        .update(findingGenerations)
        .set({ status: "current", activatedAt, staleAt: null, failureReason: null })
        .where(eq(findingGenerations.id, generationId));
      return { ...receiptFromRow(generation), status: "current" as const, activatedAt };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db
      .update(findingGenerations)
      .set({ status: "verification-failed", failureReason: reason })
      .where(and(eq(findingGenerations.id, generationId), eq(findingGenerations.status, "staging")));
    throw error;
  }
}

export async function replaceFindingGeneration(input: FindingGenerationInput): Promise<FindingGenerationReceipt> {
  try {
    verifyGeneration(input);
    return await db.transaction(async (tx) => {
      const replacementScopeKey = scopeKey(input.scope);
      const existing = await tx
        .select({ scopeKey: findingGenerations.scopeKey })
        .from(findingGenerations)
        .where(eq(findingGenerations.id, input.receipt.generationId))
        .get();
      if (existing && existing.scopeKey !== replacementScopeKey) {
        throw new FindingGenerationVerificationError(
          "Finding generation ID is already owned by a different semantic scope",
        );
      }
      await assertNoStoredConflicts(tx, input.findings);
      await tx.delete(findingGenerations).where(eq(findingGenerations.id, input.receipt.generationId));
      await insertStagedGeneration(tx, input);
      await tx
        .delete(findingGenerations)
        .where(and(
          eq(findingGenerations.scopeKey, replacementScopeKey),
          ne(findingGenerations.id, input.receipt.generationId),
          activeStatusExpression(),
        ));
      const activatedAt = new Date().toISOString();
      await tx
        .update(findingGenerations)
        .set({ status: "current", activatedAt })
        .where(eq(findingGenerations.id, input.receipt.generationId));
      return { ...input.receipt, status: "current" as const, activatedAt };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await persistVerificationFailure(input, reason);
    throw error;
  }
}

export async function markCurrentFindingGenerationStale(
  scope: FindingScope,
  status: StaleFindingGenerationStatus,
): Promise<FindingGenerationReceipt | null> {
  const current = await db
    .select({ id: findingGenerations.id })
    .from(findingGenerations)
    .where(and(eq(findingGenerations.scopeKey, scopeKey(scope)), activeStatusExpression()))
    .get();
  if (!current) return null;
  const staleAt = new Date().toISOString();
  await db
    .update(findingGenerations)
    .set({ status, staleAt })
    .where(eq(findingGenerations.id, current.id));
  const updated = await readGeneration(current.id);
  return updated?.receipt ?? null;
}
