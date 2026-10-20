import { cacheDelete } from "./telemetry-replay-storage";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { laps, sessions } from "./schema";
import { withDatabaseWrite } from "./write-coordination";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
import { getActiveExperiment } from "../experiments/active";
import { resolveActiveTestId } from "./experiment-version-queries";

export async function updateLapNotes(id: number, notes: string | null): Promise<void> {
  await withDatabaseWrite(() => db.update(laps).set({ notes }).where(eq(laps.id, id)).run());
}


export async function updateLapValidity(id: number, isValid: boolean, invalidReason: string | null, sectors?: number[] | null): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors !== undefined) values.sectorTimes = sectors;
  await withDatabaseWrite(() => db.update(laps).set(values).where(eq(laps.id, id)).run());
}

/**
 * Flip a lap's `experimentExcluded` flag (Setup Engineer `set_lap_excluded` tool,
 * docs/architecture/setup-engineer.md, and the `/api/laps/:id/experiment-excluded`
 * REST route, §Phase 7). Returns the PRIOR value plus the lap's `experimentId`
 * so the caller can log an inverse via `recordAction` for undo.
 *
 * Stamps `experimentExcludedSource = 'manual'` in BOTH directions (excluding and
 * un-excluding) — docs/architecture/setup-engineer.md.
 * This pins the lap against the auto-exclude reconciliation pass
 * (server/experiments/auto-exclude.ts) so a user's un-exclude click sticks instead of
 * the fastest-5 rule silently re-excluding it on the next lap save.
 */

export function insertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  profileId: number | null = null,
  tuneId: number | null = null,
  invalidReason: string | null = null,
  sectors: number[] | null,
  classification: LapClassification | null,
  versionIdentity?: TelemetryVersionIdentity,
): Promise<number> {
  return withDatabaseWrite(() => doInsertLap(sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, classification, versionIdentity), undefined, "lap.insert");
}

async function doInsertLap(
  sessionId: number,
  lapNumber: number,
  lapTime: number,
  isValid: boolean,
  rawByteOffset: number | null,
  rawFrameCount: number,
  profileId: number | null,
  tuneId: number | null,
  invalidReason: string | null,
  sectors: number[] | null,
  classification: LapClassification | null,
  versionIdentity?: TelemetryVersionIdentity,
): Promise<number> {
  // Stamp the lap with the active tuning session (if any). This is the single
  // choke point every live lap-detector funnels through (via the DbAdapter), so
  // reading the in-memory active id here links laps to a tuning session
  // independent of race sessionId — a tuning session can span many race
  // sessions. Cheap, unconditional on game; null when no session is active.
  const activeExperimentId = getActiveExperiment();
  const activeExperimentVersionId =
    activeExperimentId != null ? await resolveActiveTestId(activeExperimentId) : null;
  const result = await db
    .insert(laps)
    .values({
      sessionId,
      lapNumber,
      lapTime,
      isValid,
      rawByteOffset,
      rawFrameCount,
      profileId,
      sectorTimes: sectors,
      classification,
      tuneId,
      invalidReason,
      experimentId: activeExperimentId,
      experimentVersionId: activeExperimentVersionId,
      ...versionIdentity,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
}
export async function updateLapCarSetup(lapId: number, carSetup: object | null): Promise<void> {
  await withDatabaseWrite(() => db.update(laps).set({ carSetup: carSetup ? JSON.stringify(carSetup) : null }).where(eq(laps.id, lapId)).run());
}

/**
 * Backfill car/track ordinals on a session that was created before shared
 * memory static data was populated (e.g. first frames of an imported .bin
 * capture where the recorder attached before the game wrote static state).
 */
/**
 * Persist the derived per-lap metrics (migration v32) onto the lap row so the
 * next read is a plain column fetch instead of decoding every telemetry frame.
 * Null args are stored as-is (a lap with telemetry but no usable fuel/tyre
 * channel stays null and simply isn't recomputed unless its telemetry changes).
 */

export async function setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
  await withDatabaseWrite(() => db.update(laps).set({ fuelPerLap, tyreWear }).where(eq(laps.id, lapId)).run());
}


/** Delete one transient lap row without deleting its still-active parent session. */
export async function deleteLapOnly(id: number): Promise<void> {
  await withDatabaseWrite(() => db.delete(laps).where(eq(laps.id, id)).run());
  cacheDelete(id);
}

export async function deleteLap(id: number): Promise<boolean> {
  const deleted = await withDatabaseWrite(() => db.transaction(async (tx) => {
    const lap = await tx.select({ sessionId: laps.sessionId }).from(laps).where(eq(laps.id, id)).get();
    if (!lap) return false;
    const result = await tx.delete(laps).where(eq(laps.id, id)).returning().all();
    if (!result.length) return false;
    const remaining = await tx.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, lap.sessionId)).limit(1).all();
    if (!remaining.length) await tx.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
    return true;
  }));
  if (deleted) cacheDelete(id);
  return deleted;
}
