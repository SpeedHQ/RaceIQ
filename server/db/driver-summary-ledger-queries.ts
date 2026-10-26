import { and, eq, sql } from "drizzle-orm";
import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { db, readDb } from "./index";
import { laps, sessions } from "./schema";
import { withDatabaseWrite } from "./write-coordination";

export type LapDriverAttribution = "Self" | "Other" | "Mixed" | "Unknown";

export async function replaceSessionDriverAttributionStints(
  sessionId: number,
  stints: readonly DriverAttributionStint[],
): Promise<void> {
  await withDatabaseWrite(() => db.update(sessions).set({ driverAttributionStints: [...stints] }).where(eq(sessions.id, sessionId)).run());
}

export async function listSessionDriverAttributionStints(sessionId: number): Promise<DriverAttributionStint[]> {
  const row = await readDb.select({ stints: sessions.driverAttributionStints }).from(sessions).where(eq(sessions.id, sessionId)).get();
  return row?.stints ?? [];
}

export async function setLapDriverAttribution(
  lapId: number,
  stints: readonly DriverAttributionStint[],
  attribution: LapDriverAttribution,
  source: { domain: string; startMs: number; endMs: number },
): Promise<void> {
  if (!source.domain || !Number.isFinite(source.startMs) || !Number.isFinite(source.endMs) || source.endMs <= source.startMs) {
    throw new Error("Lap source-clock range is invalid");
  }
  await withDatabaseWrite(() => db.update(laps).set({
    driverAttributionStints: [...stints], driverAttribution: attribution,
    sourceClockDomain: source.domain, sourceLapStartMs: source.startMs, sourceLapEndMs: source.endMs,
  }).where(eq(laps.id, lapId)).run());
}

/** Preserve a known original identity; only capture code assigns a new original activity ID. */
export async function bindSessionOriginalActivityId(sessionId: number, originalActivityId: string): Promise<void> {
  if (!originalActivityId.trim()) throw new Error("Original activity identity is required");
  const result = await withDatabaseWrite(() => db.update(sessions).set({ originalActivityId })
    .where(and(
      eq(sessions.id, sessionId), sql`${sessions.originalActivityId} IS NULL`,
      sql`${sessions.cloudImportOrigin} IS NULL AND ${sessions.cloudImportLapId} IS NULL`,
    )).run());
  if (result.rowsAffected === 0) {
    const row = await readDb.select({ originalActivityId: sessions.originalActivityId }).from(sessions)
      .where(eq(sessions.id, sessionId)).get();
    if (!row) throw Object.assign(new Error("Session not found"), { code: "not_found" });
    if (row.originalActivityId !== originalActivityId) {
      throw Object.assign(new Error("Original activity identity cannot be reassigned"), { code: "activity_identity_conflict" });
    }
  }
}
