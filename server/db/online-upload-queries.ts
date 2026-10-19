import { sql } from "drizzle-orm";
import { db } from "./index";

export type OnlineUploadCandidate = {
  lapId: number;
  lapTimeMs: number;
  gameId: string;
  trackId: string;
  carId: string;
  valid: true;
};

const PAGE_SIZE = 100;

/** Bounded deterministic keyset page of each local game's best eligible lap per track. */
export async function getOnlineUploadCandidatePage(afterGameId = "", afterTrackId = ""): Promise<OnlineUploadCandidate[]> {
  const rows = await db.all<OnlineUploadCandidate>(sql`
    WITH eligible AS (
      SELECT laps.id AS lapId,
        CAST(ROUND(CASE WHEN laps.total_time_ms > 0 THEN laps.total_time_ms ELSE laps.lap_time * 1000 END) AS INTEGER) AS lapTimeMs,
        sessions.game_id AS gameId, sessions.track_id AS trackId, sessions.car_id AS carId,
        ROW_NUMBER() OVER (PARTITION BY sessions.game_id, sessions.track_id ORDER BY laps.lap_time ASC, laps.id ASC) AS rank
      FROM laps INNER JOIN sessions ON sessions.id = laps.session_id
      WHERE (sessions.game_id > ${afterGameId} OR (sessions.game_id = ${afterGameId} AND sessions.track_id > ${afterTrackId}))
        AND laps.is_valid = 1 AND laps.lap_time > 0
        AND sessions.ownership = 'mine'
        AND sessions.raw_file IS NOT NULL
        AND sessions.source IS NULL
        AND sessions.cloud_import_origin IS NULL AND sessions.cloud_import_lap_id IS NULL
        AND laps.raw_byte_offset IS NOT NULL AND laps.raw_frame_count > 0
        AND laps.sector_times IS NOT NULL AND json_valid(laps.sector_times)
        AND json_array_length(laps.sector_times) > 0
        AND NOT EXISTS (SELECT 1 FROM json_each(laps.sector_times) s WHERE CAST(s.value AS REAL) <= 0)
        AND sessions.game_id IN ('acc', 'ac-evo', 'iracing', 'lmu', 'f1-2025')
        AND (sessions.game_id != 'f1-2025' OR sessions.car_id = '41')
        AND sessions.raw_file NOT LIKE '%.motec.zip'
    )
    SELECT lapId, lapTimeMs, gameId, trackId, carId, 1 AS valid
    FROM eligible WHERE rank = 1
    ORDER BY gameId ASC, trackId ASC LIMIT ${PAGE_SIZE}
  `);
  return rows.filter((row) => Number.isSafeInteger(row.lapId) && Number.isSafeInteger(row.lapTimeMs) && row.lapTimeMs > 0)
    .map((row) => ({ ...row, lapId: Number(row.lapId), lapTimeMs: Number(row.lapTimeMs), valid: true as const }));
}
