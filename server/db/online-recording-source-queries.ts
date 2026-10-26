import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, readDb } from "./index";
import { onlineRecordingSources } from "./schema";
import { withDatabaseWrite } from "./write-coordination";

export interface OnlineRecordingSourceState {
  generation: number;
  reprocessPending: boolean;
  reprocessToken: string | null;
}

/** Advance source revision without stealing an active reprocess lock. */
export async function revokeOnlineRecordingSource(sessionId: number): Promise<number> {
  await withDatabaseWrite(() => db.insert(onlineRecordingSources).values({ sessionId, generation: 1 })
    .onConflictDoUpdate({ target: onlineRecordingSources.sessionId, set: { generation: sql`${onlineRecordingSources.generation}+1` } }).run(),
  undefined, "online-recording-source-revoke");
  const row = await readDb.select({ generation: onlineRecordingSources.generation })
    .from(onlineRecordingSources).where(eq(onlineRecordingSources.sessionId, sessionId)).get();
  if (!row) throw new Error(`Recording source lock ${sessionId} disappeared`);
  return row.generation;
}

/** Admit a source mutation only when no reprocess token owns this source. */
export async function tryBeginOnlineRecordingSourceMutation(sessionId: number): Promise<boolean> {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return false;
  const result = await withDatabaseWrite(() => db.update(onlineRecordingSources).set({
    generation: sql`${onlineRecordingSources.generation}+1`, reprocessPending: false, reprocessToken: null,
  }).where(and(eq(onlineRecordingSources.sessionId, sessionId), sql`${onlineRecordingSources.reprocessToken} IS NULL`)).run(),
  undefined, "online-recording-source-mutation-begin");
  return result.rowsAffected === 1;
}

/** Claim exactly the observed revision and pending state for one manual reprocess. */
export async function claimOnlineRecordingSourceReprocess(
  sessionId: number, expectedGeneration: number, requirePending: boolean,
): Promise<{ token: string; generation: number } | null> {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !Number.isSafeInteger(expectedGeneration) || expectedGeneration <= 0) return null;
  const token = randomUUID();
  const result = await withDatabaseWrite(() => db.update(onlineRecordingSources).set({
    generation: sql`${onlineRecordingSources.generation}+1`, reprocessPending: true, reprocessToken: token,
  }).where(and(eq(onlineRecordingSources.sessionId, sessionId), eq(onlineRecordingSources.generation, expectedGeneration),
    eq(onlineRecordingSources.reprocessPending, requirePending))).returning({ generation: onlineRecordingSources.generation }).get(),
  undefined, "online-recording-source-mutation-claim");
  return result ? { token, generation: result.generation } : null;
}

export async function releaseOnlineRecordingSourceReprocess(sessionId: number, token: string): Promise<boolean> {
  const result = await withDatabaseWrite(() => db.update(onlineRecordingSources).set({ reprocessPending: false, reprocessToken: null })
    .where(and(eq(onlineRecordingSources.sessionId, sessionId), eq(onlineRecordingSources.reprocessPending, true),
      eq(onlineRecordingSources.reprocessToken, token))).run(), undefined, "online-recording-source-mutation-release");
  return result.rowsAffected === 1;
}

/** Release only matching reprocess token/revision; this does not publish source readiness. */
export async function completeOnlineRecordingSourceReprocess(sessionId: number, token: string, expectedGeneration: number): Promise<boolean> {
  const result = await withDatabaseWrite(() => db.update(onlineRecordingSources).set({ reprocessPending: false, reprocessToken: null })
    .where(and(eq(onlineRecordingSources.sessionId, sessionId), eq(onlineRecordingSources.reprocessPending, true),
      eq(onlineRecordingSources.reprocessToken, token), eq(onlineRecordingSources.generation, expectedGeneration))).run(),
  undefined, "online-recording-source-mutation-complete");
  return result.rowsAffected === 1;
}

export async function readOnlineRecordingSource(sessionId: number): Promise<OnlineRecordingSourceState | null> {
  const row = await readDb.select().from(onlineRecordingSources).where(eq(onlineRecordingSources.sessionId, sessionId)).get();
  return row ? { generation: row.generation, reprocessPending: row.reprocessPending, reprocessToken: row.reprocessToken } : null;
}
