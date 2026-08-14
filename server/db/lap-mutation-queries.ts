import { cacheDelete } from "./telemetry-replay-storage";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { sessions, laps } from "./schema";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { LapClassification } from "../../shared/racing/laps/classification";
import { getActiveExperiment } from "../experiments/active";
import { resolveActiveTestId } from "./experiment-version-queries";

export async function updateLapNotes(id: number, notes: string | null): Promise<void> {
  await db.update(laps).set({ notes }).where(eq(laps.id, id)).run();
}


export async function updateLapValidity(id: number, isValid: boolean, invalidReason: string | null, sectors?: number[] | null): Promise<void> {
  const values: Record<string, unknown> = { isValid, invalidReason };
  if (sectors !== undefined) {
    values.sectorTimes = sectors;
  }
  await db.update(laps).set(values).where(eq(laps.id, id)).run();
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
  sectors: number[] | null = null,
  versionIdentity?: TelemetryVersionIdentity,
  classification?: LapClassification,
): Promise<number> {
  return doInsertLap(sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, versionIdentity, classification);
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
  sectors: number[] | null = null,
  versionIdentity?: TelemetryVersionIdentity,
  classification?: LapClassification,
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
      sectorTimes: sectors,
      profileId,
      tuneId,
      invalidReason,
      ...classification,
      experimentId: activeExperimentId,
      experimentVersionId: activeExperimentVersionId,
      ...versionIdentity,
    })
    .returning({ id: laps.id })
    .get();
  return result.id;
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
  await db.update(laps).set({ fuelPerLap, tyreWear }).where(eq(laps.id, lapId)).run();
}


export async function deleteLap(id: number): Promise<boolean> {
  // Get session ID before deleting
  const lap = await db.select({ sessionId: laps.sessionId }).from(laps).where(eq(laps.id, id)).get();
  const result = await db.delete(laps).where(eq(laps.id, id)).returning().all();
  if (result.length > 0) {
    cacheDelete(id);
    // Clean up empty parent session
    if (lap) {
      const remaining = await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, lap.sessionId)).limit(1).all();
      if (remaining.length === 0) {
        await db.delete(sessions).where(eq(sessions.id, lap.sessionId)).run();
      }
    }
  }
  return result.length > 0;
}
