import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../db/index";
import { findingGenerations, findingRecords, laps, sessions } from "../db/schema";
import { assertNoFindingConflicts, canonicalJson } from "../../shared/racing/findings/identity";
import { GameIdSchema, KNOWN_GAME_IDS, type GameId } from "../../shared/games/ids";
import { validateFinding } from "../../shared/racing/findings/validate";
import type { FindingGenerationReceipt, FindingGenerationStatus, FindingRecord, FindingScope } from "../../shared/racing/findings/types";

const ACTIVE_STATUSES = ["current", "stale-rebuild-available", "stale-source-missing"] as const;
export const MAX_FINDING_STRUCTURED_BYTES = 256 * 1024;
export const MAX_FINDING_GENERATION_STRUCTURED_BYTES = 2 * 1024 * 1024;
export type ActiveFindingGenerationStatus = (typeof ACTIVE_STATUSES)[number];
export type StaleFindingGenerationStatus = Exclude<ActiveFindingGenerationStatus, "current">;
export interface FindingGenerationExpectation {
  scope: FindingScope;
  generationId: string;
  contentHash: string;
}

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
  const serialized = canonicalJson(structured);
  const size = Buffer.byteLength(serialized);
  if (size > MAX_FINDING_STRUCTURED_BYTES) {
    throw new FindingGenerationVerificationError(`Finding ${finding.id} structured payload exceeds ${MAX_FINDING_STRUCTURED_BYTES} bytes`);
  }
  return serialized;
}

export function findingGenerationContentHash(findings: readonly FindingRecord[]): string {
  let totalSize = 0;
  const ordered = findings
    .map((finding) => {
      const serialized = structuredFindingJson(finding);
      totalSize += Buffer.byteLength(serialized);
      if (totalSize > MAX_FINDING_GENERATION_STRUCTURED_BYTES) {
        throw new FindingGenerationVerificationError(`Finding generation structured payload exceeds ${MAX_FINDING_GENERATION_STRUCTURED_BYTES} bytes`);
      }
      return { id: finding.id, structured: JSON.parse(serialized) };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const serializedGeneration = canonicalJson(ordered);
  if (Buffer.byteLength(serializedGeneration) > MAX_FINDING_GENERATION_STRUCTURED_BYTES) {
    throw new FindingGenerationVerificationError(`Finding generation structured payload exceeds ${MAX_FINDING_GENERATION_STRUCTURED_BYTES} bytes`);
  }
  return digest(serializedGeneration);
}

export function findingGenerationCounts(findings: readonly FindingRecord[]): Pick<FindingGenerationReceipt, "findingCount" | "availableCount" | "unavailableCount" | "indeterminateCount"> {
  return {
    findingCount: findings.length,
    availableCount: findings.filter((finding) => finding.status === "available").length,
    unavailableCount: findings.filter((finding) => finding.status === "unavailable").length,
    indeterminateCount: findings.filter((finding) => finding.status === "indeterminate").length,
  };
}

export function createFindingGenerationReceipt(
  input: Omit<FindingGenerationReceipt, "status" | "findingCount" | "availableCount" | "unavailableCount" | "indeterminateCount" | "contentHash" | "activatedAt" | "staleAt" | "failureReason">,
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

function lapIdForScope(scope: FindingScope): number | null {
  if (scope.kind !== "lap") return null;
  if (typeof scope.lapId !== "string" || !/^[1-9]\d*$/.test(scope.lapId)) return null;
  const lapId = Number(scope.lapId);
  return Number.isSafeInteger(lapId) ? lapId : null;
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
  if (!GameIdSchema.safeParse(input.scope.gameId).success) {
    throw new FindingGenerationVerificationError("Finding generation scope game ID is not registered");
  }
  if (input.scope.kind === "lap" && lapIdForScope(input.scope) === null) {
    throw new FindingGenerationVerificationError("Lap finding scope must include a positive numeric lap ID");
  }
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
      throw new FindingGenerationVerificationError(`Finding ${finding.id} failed validation: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`);
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

async function assertNoStoredConflicts(database: FindingsDatabase, findings: readonly FindingRecord[]): Promise<void> {
  if (findings.length === 0) return;
  const candidates = await database
    .select({ structured: findingRecords.structured })
    .from(findingRecords)
    .where(
      inArray(
        findingRecords.findingId,
        findings.map((finding) => finding.id),
      ),
    );
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
    lapId: lapIdForScope(input.scope),
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
    await database.insert(findingRecords).values(
      input.findings.map((finding) => {
        const structured = structuredFindingJson(finding);
        return {
          generationId: input.receipt.generationId,
          findingId: finding.id,
          type: finding.type,
          status: finding.status,
          structured,
          structuredHash: digest(structured),
        };
      }),
    );
  }
}
async function persistVerificationFailure(input: FindingGenerationInput, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ scopeKey: findingGenerations.scopeKey, status: findingGenerations.status })
      .from(findingGenerations)
      .where(eq(findingGenerations.id, input.receipt.generationId))
      .get();
    if (existing && (existing.scopeKey !== scopeKey(input.scope) || ACTIVE_STATUSES.includes(existing.status as ActiveFindingGenerationStatus))) return;
    if (existing) await tx.delete(findingGenerations).where(eq(findingGenerations.id, input.receipt.generationId));
    await tx.insert(findingGenerations).values(generationValues(input, "verification-failed", reason));
  });
}
export async function stageFindingGeneration(input: FindingGenerationInput): Promise<FindingGenerationReceipt> {
  try {
    verifyGeneration(input);
    await db.transaction(async (tx) => {
      const existing = await tx.select({ status: findingGenerations.status }).from(findingGenerations).where(eq(findingGenerations.id, input.receipt.generationId)).get();
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

async function readGenerationFrom(database: FindingsDatabase, generationId: string): Promise<StoredFindingGeneration | null> {
  const generation = await database.select().from(findingGenerations).where(eq(findingGenerations.id, generationId)).get();
  if (!generation) return null;
  const records = await database.select({ structured: findingRecords.structured }).from(findingRecords).where(eq(findingRecords.generationId, generationId)).orderBy(findingRecords.findingId);
  const findings = records.map((record) => JSON.parse(record.structured) as FindingRecord);
  const counts = findingGenerationCounts(findings);
  if (
    generation.status !== "verification-failed" &&
    (counts.findingCount !== generation.findingCount ||
      counts.availableCount !== generation.availableCount ||
      counts.unavailableCount !== generation.unavailableCount ||
      counts.indeterminateCount !== generation.indeterminateCount ||
      findingGenerationContentHash(findings) !== generation.contentHash)
  ) {
    throw new FindingGenerationVerificationError("Stored finding generation failed count/hash verification");
  }
  return { scope: JSON.parse(generation.scope), receipt: receiptFromRow(generation), findings };
}

export async function getFindingGeneration(generationId: string): Promise<StoredFindingGeneration | null> {
  try {
    return await db.transaction((tx) => readGenerationFrom(tx, generationId));
  } catch (error) {
    if (error instanceof FindingGenerationVerificationError) return null;
    throw error;
  }
}

export async function getCurrentFindingGeneration(scope: FindingScope): Promise<StoredFindingGeneration | null> {
  try {
    return await db.transaction(async (tx) => {
      const generation = await tx
        .select({ id: findingGenerations.id })
        .from(findingGenerations)
        .where(and(eq(findingGenerations.scopeKey, scopeKey(scope)), eq(findingGenerations.status, "current")))
        .get();
      return generation ? readGenerationFrom(tx, generation.id) : null;
    });
  } catch (error) {
    if (error instanceof FindingGenerationVerificationError) return null;
    throw error;
  }
}

/** Newest active generation, including stale statuses. Current reads must use getCurrentFindingGeneration. */
export async function getLatestFindingGeneration(scope: FindingScope): Promise<StoredFindingGeneration | null> {
  try {
    return await db.transaction(async (tx) => {
      const generation = await tx
        .select({ id: findingGenerations.id })
        .from(findingGenerations)
        .where(and(eq(findingGenerations.scopeKey, scopeKey(scope)), activeStatusExpression()))
        .orderBy(desc(findingGenerations.createdAt), desc(findingGenerations.id))
        .get();
      return generation ? readGenerationFrom(tx, generation.id) : null;
    });
  } catch (error) {
    if (error instanceof FindingGenerationVerificationError) return null;
    throw error;
  }
}

async function activateBatchInTransaction(tx: FindingsDatabase, generationIds: readonly string[]): Promise<FindingGenerationReceipt[]> {
  if (generationIds.length === 0) throw new FindingGenerationVerificationError("Finding generation activation batch cannot be empty");
  if (new Set(generationIds).size !== generationIds.length) throw new FindingGenerationVerificationError("Finding generation activation batch contains duplicate IDs");
  const rows: Array<{ row: typeof findingGenerations.$inferSelect; stored: StoredFindingGeneration }> = [];
  const scopeKeys = new Set<string>();
  for (const generationId of generationIds) {
    const row = await tx.select().from(findingGenerations).where(eq(findingGenerations.id, generationId)).get();
    if (!row || row.status !== "staging") throw new FindingGenerationVerificationError("Only staged finding generations can be activated");
    const stored = await readGenerationFrom(tx, generationId);
    if (!stored) throw new FindingGenerationVerificationError("Staged finding generation disappeared during activation");
    if (scopeKeys.has(row.scopeKey)) throw new FindingGenerationVerificationError("Finding generation activation batch contains duplicate scopes");
    scopeKeys.add(row.scopeKey);
    await assertNoStoredConflicts(tx, stored.findings);
    rows.push({ row, stored });
  }
  const sessionId = rows[0]!.stored.scope.sessionId;
  const gameId = rows[0]!.stored.scope.gameId;
  if (rows.some(({ stored }) => stored.scope.sessionId !== sessionId || stored.scope.gameId !== gameId))
    throw new FindingGenerationVerificationError("Finding generation activation batch must belong to one session and game");

  // Keep prior generations queryable as stale history. Updating their status
  // avoids the active-scope uniqueness conflict without cascading records.
  const staleAt = new Date().toISOString();
  await tx
    .update(findingGenerations)
    .set({ status: "stale-rebuild-available", staleAt })
    .where(and(inArray(findingGenerations.scopeKey, [...scopeKeys]), activeStatusExpression()));
  const activatedAt = new Date().toISOString();
  const receipts: FindingGenerationReceipt[] = [];
  for (const { row, stored } of rows) {
    await tx.update(findingGenerations).set({ status: "current", activatedAt, staleAt: null, failureReason: null }).where(eq(findingGenerations.id, row.id));
    receipts.push({ ...stored.receipt, status: "current", activatedAt });
  }
  return receipts;
}

export async function activateFindingGenerationBatch(generationIds: readonly string[]): Promise<FindingGenerationReceipt[]> {
  try {
    return await db.transaction((tx) => activateBatchInTransaction(tx, generationIds));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (generationIds.length > 0)
      await db
        .update(findingGenerations)
        .set({ status: "verification-failed", failureReason: reason })
        .where(and(inArray(findingGenerations.id, [...new Set(generationIds)]), eq(findingGenerations.status, "staging")));
    throw error;
  }
}

export async function activateFindingGeneration(generationId: string): Promise<FindingGenerationReceipt> {
  const [receipt] = await activateFindingGenerationBatch([generationId]);
  return receipt!;
}

export async function replaceFindingGenerationsBatch(inputs: readonly FindingGenerationInput[]): Promise<FindingGenerationReceipt[]> {
  if (inputs.length === 0) throw new FindingGenerationVerificationError("Finding generation replacement batch cannot be empty");
  try {
    for (const input of inputs) verifyGeneration(input);
    const sessionId = inputs[0]!.scope.sessionId;
    const gameId = inputs[0]!.scope.gameId;
    if (inputs.some((input) => input.scope.sessionId !== sessionId || input.scope.gameId !== gameId))
      throw new FindingGenerationVerificationError("Finding generation replacement batch must belong to one session and game");
    return await db.transaction(async (tx) => {
      const ids = new Set<string>();
      for (const input of inputs) {
        if (ids.has(input.receipt.generationId)) throw new FindingGenerationVerificationError("Finding generation replacement batch contains duplicate IDs");
        ids.add(input.receipt.generationId);
        const existing = await tx.select({ scopeKey: findingGenerations.scopeKey }).from(findingGenerations).where(eq(findingGenerations.id, input.receipt.generationId)).get();
        if (existing && existing.scopeKey !== scopeKey(input.scope)) throw new FindingGenerationVerificationError("Finding generation ID is already owned by a different semantic scope");
        await assertNoStoredConflicts(tx, input.findings);
        if (existing) await tx.delete(findingGenerations).where(eq(findingGenerations.id, input.receipt.generationId));
        await insertStagedGeneration(tx, input);
      }
      return activateBatchInTransaction(
        tx,
        inputs.map((input) => input.receipt.generationId),
      );
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const input of inputs) await persistVerificationFailure(input, reason);
    throw error;
  }
}

export async function replaceFindingGeneration(input: FindingGenerationInput): Promise<FindingGenerationReceipt> {
  const [receipt] = await replaceFindingGenerationsBatch([input]);
  return receipt!;
}

export async function markCurrentFindingGenerationStale(scope: FindingScope, status: StaleFindingGenerationStatus): Promise<FindingGenerationReceipt | null> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ id: findingGenerations.id })
      .from(findingGenerations)
      .where(and(eq(findingGenerations.scopeKey, scopeKey(scope)), eq(findingGenerations.status, "current")))
      .get();
    if (!current) return null;
    await tx
      .update(findingGenerations)
      .set({ status, staleAt: new Date().toISOString() })
      .where(and(eq(findingGenerations.id, current.id), eq(findingGenerations.status, "current")));
    const updated = await readGenerationFrom(tx, current.id);
    return updated?.receipt ?? null;
  });
}

export async function listSessionsMissingCurrentFindingGeneration(gameId: GameId): Promise<number[]> {
  const lapIds = await listLapsMissingCurrentFindingGeneration(gameId);
  if (lapIds.length === 0) return [];
  const rows = await db.selectDistinct({ sessionId: laps.sessionId }).from(laps).where(inArray(laps.id, lapIds)).orderBy(laps.sessionId);
  return rows.map(({ sessionId }) => sessionId);
}

export async function listLapsMissingCurrentFindingGeneration(gameId: GameId, sessionId?: number): Promise<number[]> {
  const conditions = [eq(sessions.gameId, gameId)];
  if (sessionId !== undefined) conditions.push(eq(laps.sessionId, sessionId));
  const lapRows = await db
    .select({ id: laps.id })
    .from(laps)
    .innerJoin(sessions, eq(laps.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(laps.id);
  if (lapRows.length === 0) return [];
  const currentRows = await db
    .select({ lapId: findingGenerations.lapId })
    .from(findingGenerations)
    .where(
      and(
        eq(findingGenerations.status, "current"),
        inArray(
          findingGenerations.lapId,
          lapRows.map((lap) => lap.id),
        ),
      ),
    );
  const currentLaps = new Set(currentRows.flatMap((row) => (row.lapId === null ? [] : [row.lapId])));
  return lapRows.filter((lap) => !currentLaps.has(lap.id)).map((lap) => lap.id);
}

/** Idempotent backfill source across all games. */
export async function listSessionsMissingCurrentFindingGenerations(): Promise<number[]> {
  const ids = await Promise.all(KNOWN_GAME_IDS.map((gameId) => listSessionsMissingCurrentFindingGeneration(gameId)));
  return [...new Set(ids.flat())].sort((a, b) => a - b);
}
