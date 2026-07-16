import { asc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { tuningTests } from "./schema";

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
