import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { laps, tuningSessions, tuningTests } from "./schema";

export interface CreateTuningTestData {
  tuningSessionId: number;
  version: number;
  label: string;
  setupPath?: string | null;
  parentTestId?: number | null;
  /** AppliedChange[] from the autotune engine, serialised to JSON. */
  appliedChanges?: string | null;
  driverComment?: string | null;
  engine?: string | null;
  /** F1's captured base / target F1CarSetup JSON; null for file-based nodes. */
  setupSnapshot?: string | null;
}

export async function createTuningTest(data: CreateTuningTestData): Promise<number> {
  const result = await db
    .insert(tuningTests)
    .values({
      tuningSessionId: data.tuningSessionId,
      version: data.version,
      label: data.label,
      setupPath: data.setupPath ?? null,
      parentTestId: data.parentTestId ?? null,
      appliedChanges: data.appliedChanges ?? null,
      driverComment: data.driverComment ?? null,
      engine: data.engine ?? null,
      setupSnapshot: data.setupSnapshot ?? null,
    })
    .returning({ id: tuningTests.id })
    .get();
  return result.id;
}

/** Tests for a session, oldest-first (v1 base → latest) so the UI can render
 *  the version history in creation order and attach live laps to the last row. */
export async function listTuningTests(sessionId: number) {
  return await db
    .select()
    .from(tuningTests)
    .where(eq(tuningTests.tuningSessionId, sessionId))
    .orderBy(asc(tuningTests.version), asc(tuningTests.id))
    .all();
}

export async function getTuningTest(id: number) {
  return (await db.select().from(tuningTests).where(eq(tuningTests.id, id)).get()) ?? null;
}

/** Next version number for a session — max(version) + 1, or 1 when none exist. */
export async function nextVersion(sessionId: number): Promise<number> {
  const row = await db
    .select({ maxVersion: sql<number | null>`MAX(${tuningTests.version})` })
    .from(tuningTests)
    .where(eq(tuningTests.tuningSessionId, sessionId))
    .get();
  return (row?.maxVersion ?? 0) + 1;
}

/**
 * The test id the Setup Engineer should currently work from: the session's
 * persisted head if set, else the highest-version test (mainline tip), else
 * null when the session has no tests yet.
 */
export async function resolveActiveTestId(sessionId: number): Promise<number | null> {
  const session = await db
    .select({ headTestId: tuningSessions.headTestId })
    .from(tuningSessions)
    .where(eq(tuningSessions.id, sessionId))
    .get();
  if (session?.headTestId != null) return session.headTestId;

  const tip = await db
    .select({ id: tuningTests.id })
    .from(tuningTests)
    .where(eq(tuningTests.tuningSessionId, sessionId))
    .orderBy(desc(tuningTests.version), desc(tuningTests.id))
    .get();
  return tip?.id ?? null;
}

/** Lap count + best (min positive) lap time per tuning_test_id for a session. */
export async function getLapCountsByTest(
  sessionId: number,
): Promise<Map<number, { lapCount: number; bestLapMs: number | null }>> {
  const rows = await db
    .select({
      testId: laps.tuningTestId,
      lapCount: sql<number>`COUNT(*)`,
      bestLapMs: sql<number | null>`MIN(CASE WHEN ${laps.lapTime} > 0 THEN ${laps.lapTime} END)`,
    })
    .from(laps)
    .where(eq(laps.tuningSessionId, sessionId))
    .groupBy(laps.tuningTestId)
    .all();

  const map = new Map<number, { lapCount: number; bestLapMs: number | null }>();
  for (const r of rows) {
    if (r.testId == null) continue;
    map.set(r.testId, { lapCount: Number(r.lapCount), bestLapMs: r.bestLapMs ?? null });
  }
  return map;
}
