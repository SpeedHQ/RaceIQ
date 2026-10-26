import { and, eq, isNull, sql } from "drizzle-orm";
import { isWholeLapSelf } from "@raceiq/shared/driver-attribution";
import { db } from "./index";
import { getRecordingInstallationId } from "./recording-origin";
import { withDatabaseWrite } from "./write-coordination";
import { laps, onlineFastestLapInitialization } from "./schema";

export function fastestLapUpsert(gameId: string, trackId: string, carId: string, lapId: number, lapTimeMs: number) {
  return sql`INSERT INTO online_fastest_combo_laps(game_id,track_id,car_id,lap_id,lap_time_ms)
    VALUES(${gameId},${trackId},${carId},${lapId},${lapTimeMs})
    ON CONFLICT(game_id,track_id,car_id) DO UPDATE SET lap_id=excluded.lap_id,lap_time_ms=excluded.lap_time_ms
    WHERE online_fastest_combo_laps.lap_id IS NULL OR online_fastest_combo_laps.lap_time_ms IS NULL
      OR excluded.lap_time_ms<online_fastest_combo_laps.lap_time_ms`;
}

interface InitializationLapRow {
  id: number;
  gameId: string;
  trackId: string;
  carId: string;
  lapTimeMs: number;
  isValid: number;
  invalidReason: string | null;
  attribution: string | null;
  stintsJson: string | null;
  clockDomain: string | null;
  lapStartMs: number | null;
  lapEndMs: number | null;
  recordingOrigin: string;
  recordingInstallationId: string | null;
}

/** Bounded one-time initialization; live finalization handles rows inserted after the cursor. */
export async function initializeOnlineFastestLapWinners(batchSize = 200): Promise<{ processed: number; complete: boolean }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new RangeError("Online initialization batch size must be positive");
  return withDatabaseWrite(() => db.transaction(async (tx) => {
    const state = await tx.select().from(onlineFastestLapInitialization).where(eq(onlineFastestLapInitialization.id, 1)).get();
    if (!state) throw new Error("Online fastest-lap initialization state is missing");
    if (state.complete) return { processed: 0, complete: true };
    const rows = await tx.all<InitializationLapRow>(sql`SELECT l.id,s.game_id AS gameId,s.track_id AS trackId,s.car_id AS carId,
      CAST(ROUND(CASE WHEN l.total_time_ms>0 THEN l.total_time_ms ELSE l.lap_time*1000 END) AS INTEGER) AS lapTimeMs,
      l.is_valid AS isValid,l.invalid_reason AS invalidReason,l.driver_attribution AS attribution,
      l.driver_attribution_stints AS stintsJson,l.source_clock_domain AS clockDomain,
      l.source_lap_start_ms AS lapStartMs,l.source_lap_end_ms AS lapEndMs,
      s.recording_origin AS recordingOrigin,s.recording_installation_id AS recordingInstallationId
      FROM laps l JOIN sessions s ON s.id=l.session_id WHERE l.id>${state.lastCheckedLapId}
      ORDER BY l.id LIMIT ${batchSize}`);
    if (rows.length === 0) {
      await tx.update(onlineFastestLapInitialization).set({ complete: true })
        .where(and(eq(onlineFastestLapInitialization.id, 1), eq(onlineFastestLapInitialization.lastCheckedLapId, state.lastCheckedLapId))).run();
      return { processed: 0, complete: true };
    }
    const installationId = rows.some((row) => row.recordingOrigin === "native_capture") ? getRecordingInstallationId() : null;
    for (const row of rows) {
      const provisional = row.invalidReason === "incomplete";
      const marker = await tx.update(laps).set({ onlineEvaluatedAt: new Date().toISOString() })
        .where(and(eq(laps.id, row.id), isNull(laps.onlineEvaluatedAt), sql`${laps.invalidReason} IS NOT 'incomplete'`)).run();
      if (Number(marker.rowsAffected) !== 1 || provisional || row.isValid !== 1 ||
          row.recordingOrigin !== "native_capture" || !installationId || row.recordingInstallationId !== installationId ||
          row.attribution !== "Self" || !Number.isSafeInteger(row.lapTimeMs) || row.lapTimeMs <= 0 ||
          !row.gameId || !row.trackId || row.trackId === "-1" || !row.carId || row.carId === "-1" ||
          !row.stintsJson || row.clockDomain === null || row.lapStartMs === null || row.lapEndMs === null) continue;
      let stints: unknown;
      try { stints = JSON.parse(row.stintsJson); } catch { continue; }
      if (!Array.isArray(stints) || stints.some((stint) => stint === null || typeof stint !== "object") ||
          !isWholeLapSelf(stints, row.lapStartMs, row.lapEndMs, row.clockDomain)) continue;
      await tx.run(fastestLapUpsert(row.gameId, row.trackId, row.carId, row.id, row.lapTimeMs));
    }
    const lastId = rows.at(-1)!.id;
    await tx.update(onlineFastestLapInitialization).set({ lastCheckedLapId: lastId })
      .where(and(eq(onlineFastestLapInitialization.id, 1), eq(onlineFastestLapInitialization.lastCheckedLapId, state.lastCheckedLapId))).run();
    return { processed: rows.length, complete: false };
  }));
}
