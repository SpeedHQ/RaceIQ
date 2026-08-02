import type { AnalysisUsage } from "./analysis-queries";
import { eq, desc, and, sql } from "drizzle-orm";
import { db } from "./index";
import { driverProfiles, driverProfileRuns } from "./schema";
import type { GameId } from "../../shared/types";

export interface DriverProfileScopeKey {
  gameId: GameId;
  carOrdinal?: number | null;
  trackOrdinal?: number | null;
}

/**
 * Canonical cache key for a profile scope.
 *
 * `*` stands in for an unset ordinal rather than leaning on SQL NULL, because
 * SQLite treats NULLs as distinct in a UNIQUE index — two global-scope rows
 * would both insert and the upsert would never replace the one it meant to.
 */

export function driverProfileScopeKey(scope: DriverProfileScopeKey): string {
  const car = scope.carOrdinal ?? "*";
  const track = scope.trackOrdinal ?? "*";
  return `${scope.gameId}|${car}|${track}`;
}


export interface DriverProfileRow {
  scopeKey: string;
  poolKey: string;
  fingerprint: string;
  plan: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
  createdAt: string;
}


export type DriverProfileRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface DriverProfileRunRow {
  id: number;
  scopeKey: string;
  gameId: GameId;
  carOrdinal: number | null;
  trackOrdinal: number | null;
  poolKey: string;
  status: DriverProfileRunStatus;
  /** JSON snapshot strings; callers own parsing against the relevant schemas. */
  fingerprint: string | null;
  plan: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}


export interface CreateDriverProfileRunInput {
  poolKey: string;
  status?: DriverProfileRunStatus;
  fingerprint?: string | null;
  plan?: string | null;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}


export interface UpdateDriverProfileRunInput {
  status?: DriverProfileRunStatus;
  fingerprint?: string | null;
  plan?: string | null;
  error?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}


export async function getDriverProfile(scope: DriverProfileScopeKey): Promise<DriverProfileRow | null> {
  const row = await db
    .select({
      scopeKey: driverProfiles.scopeKey,
      poolKey: driverProfiles.poolKey,
      fingerprint: driverProfiles.fingerprint,
      plan: driverProfiles.plan,
      inputTokens: driverProfiles.inputTokens,
      outputTokens: driverProfiles.outputTokens,
      costUsd: driverProfiles.costUsd,
      durationMs: driverProfiles.durationMs,
      model: driverProfiles.model,
      createdAt: driverProfiles.createdAt,
    })
    .from(driverProfiles)
    .where(eq(driverProfiles.scopeKey, driverProfileScopeKey(scope)))
    .get();
  return row ?? null;
}

/** Save or replace the cached DriverProfileSummary snapshot for a scope. */

export async function saveDriverProfile(
  scope: DriverProfileScopeKey,
  data: { poolKey: string; fingerprint: string; plan: string; usage: AnalysisUsage },
): Promise<void> {
  const scopeKey = driverProfileScopeKey(scope);
  const values = {
    poolKey: data.poolKey,
    fingerprint: data.fingerprint,
    plan: data.plan,
    inputTokens: data.usage.inputTokens,
    outputTokens: data.usage.outputTokens,
    costUsd: data.usage.costUsd,
    durationMs: data.usage.durationMs,
    model: data.usage.model,
    createdAt: sql`(datetime('now'))`,
  };

  const existing = await db
    .select({ id: driverProfiles.id })
    .from(driverProfiles)
    .where(eq(driverProfiles.scopeKey, scopeKey))
    .get();

  if (existing) {
    await db.update(driverProfiles).set(values).where(eq(driverProfiles.scopeKey, scopeKey)).run();
  } else {
    await db
      .insert(driverProfiles)
      .values({
        scopeKey,
        gameId: scope.gameId,
        carOrdinal: scope.carOrdinal ?? null,
        trackOrdinal: scope.trackOrdinal ?? null,
        ...values,
      })
      .run();
  }
}



export async function createDriverProfileRun(
  scope: DriverProfileScopeKey,
  data: CreateDriverProfileRunInput,
): Promise<number> {
  const result = await db
    .insert(driverProfileRuns)
    .values({
      scopeKey: driverProfileScopeKey(scope),
      gameId: scope.gameId,
      carOrdinal: scope.carOrdinal ?? null,
      trackOrdinal: scope.trackOrdinal ?? null,
      poolKey: data.poolKey,
      status: data.status ?? "queued",
      fingerprint: data.fingerprint ?? null,
      plan: data.plan ?? null,
      error: data.error ?? null,
      inputTokens: data.inputTokens ?? 0,
      outputTokens: data.outputTokens ?? 0,
      costUsd: data.costUsd ?? 0,
      durationMs: data.durationMs ?? 0,
      model: data.model ?? "",
      createdAt: data.createdAt ?? sql`(datetime('now'))`,
      startedAt: data.startedAt ?? null,
      completedAt: data.completedAt ?? null,
    })
    .returning({ id: driverProfileRuns.id })
    .get();
  return result.id;
}


export async function updateDriverProfileRun(
  id: number,
  scopeKey: string,
  expectedStatus: DriverProfileRunStatus,
  patch: UpdateDriverProfileRunInput,
): Promise<void> {
  const nextStatus = patch.status ?? expectedStatus;
  const allowedTransitions: Record<DriverProfileRunStatus, readonly DriverProfileRunStatus[]> = {
    queued: ["queued", "running", "failed"],
    running: ["running", "succeeded", "failed"],
    succeeded: ["succeeded"],
    failed: ["failed"],
  };
  if (!allowedTransitions[expectedStatus].includes(nextStatus)) {
    throw new Error(`Invalid driver profile run transition: ${expectedStatus} -> ${nextStatus}`);
  }

  const values = {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.fingerprint !== undefined ? { fingerprint: patch.fingerprint } : {}),
    ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.inputTokens !== undefined ? { inputTokens: patch.inputTokens } : {}),
    ...(patch.outputTokens !== undefined ? { outputTokens: patch.outputTokens } : {}),
    ...(patch.costUsd !== undefined ? { costUsd: patch.costUsd } : {}),
    ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
  };
  if (Object.keys(values).length === 0) return;

  const result = await db
    .update(driverProfileRuns)
    .set(values)
    .where(and(
      eq(driverProfileRuns.id, id),
      eq(driverProfileRuns.scopeKey, scopeKey),
      eq(driverProfileRuns.status, expectedStatus),
    ))
    .run();
  if (result.rowsAffected !== 1) {
    throw new Error(`Driver profile run ${id} was not owned by scope or status ${expectedStatus}`);
  }
}


export async function getDriverProfileRun(id: number): Promise<DriverProfileRunRow | null> {
  const row = await db
    .select()
    .from(driverProfileRuns)
    .where(eq(driverProfileRuns.id, id))
    .get();
  return row ? { ...row, gameId: row.gameId as GameId } : null;
}


export async function listDriverProfileRuns(
  scope: DriverProfileScopeKey,
  limit = 50,
): Promise<DriverProfileRunRow[]> {
  const rows = await db
    .select()
    .from(driverProfileRuns)
    .where(eq(driverProfileRuns.scopeKey, driverProfileScopeKey(scope)))
    .orderBy(desc(sql`datetime(${driverProfileRuns.createdAt})`), desc(driverProfileRuns.id))
    .limit(limit)
    .all();
  return rows.map((row) => ({ ...row, gameId: row.gameId as GameId }));
}


export async function findDriverProfileRunByScopePool(
  scope: DriverProfileScopeKey,
  poolKey: string,
): Promise<DriverProfileRunRow | null> {
  const row = await db
    .select()
    .from(driverProfileRuns)
    .where(and(
      eq(driverProfileRuns.scopeKey, driverProfileScopeKey(scope)),
      eq(driverProfileRuns.poolKey, poolKey),
    ))
    .orderBy(desc(sql`datetime(${driverProfileRuns.createdAt})`), desc(driverProfileRuns.id))
    .get();
  return row ? { ...row, gameId: row.gameId as GameId } : null;
}
