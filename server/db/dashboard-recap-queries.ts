import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionRecap } from "@raceiq/shared/racing/sessions/types";
import { dashboardCarIdentity, dashboardLapMetricFlags, dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import { computeRecap, type RecapLapInput } from "../lap-analysis/recap";
import { getLMUCar, getLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { DASHBOARD_PROCESSOR_VERSION } from "./dashboard-summary-queries";
import { readClient } from "./index";
import { dashboardLapAttribution } from "../driver-summary/dashboard-input";

const asNumber = (value: unknown): number => Number(value);
const maybeNumber = (value: unknown): number | null => value == null ? null : asNumber(value);
const parseJson = <T>(value: unknown): T | null => {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as T; } catch { return null; }
};


/** Capture-free, exact-mine dashboard recap. Returns null for unavailable sessions. */
export async function getDashboardSessionRecap(id: number, gameId: GameId): Promise<SessionRecap | null> {
  const tx = await readClient.transaction("read");
  try {
    const selected = await tx.execute({
      sql: `SELECT s.id,s.game_id,s.created_at,s.car_id,s.track_id,s.driver_attribution_stints,
          p.source_revision,p.published_revision,p.processor_version,p.metadata_dirty,p.capture_dirty,p.deleted,
          d.source_revision AS summary_source_revision,d.processor_version AS summary_processor_version,d.evidence_version,
          d.best_lap_seconds,d.track_length_meters,d.sector_layout_key,d.sector_count,d.sector_status,
          d.weather_status,d.weather_conditions_json,d.source_sector_starts_json
        FROM sessions s LEFT JOIN dashboard_summary_state p ON p.session_id=s.id
        LEFT JOIN dashboard_session_summaries d ON d.session_id=s.id
        WHERE s.id=? AND s.game_id=? AND s.ownership='mine'
          AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
          AND (s.owner_user_id IS NULL OR s.owner_user_id=(SELECT online_user_id FROM local_account_owner WHERE id=1))`, args: [id, gameId],
    });
    const session = selected.rows[0];
    if (!session) { await tx.commit(); return null; }
    const lapResult = await tx.execute({
      sql: `SELECT id,lap_number,lap_time,is_valid,classification,sector_times,invalid_reason,
          driver_attribution_stints,source_clock_domain,source_lap_start_ms,source_lap_end_ms FROM laps
        WHERE session_id=? ORDER BY lap_number,id`, args: [id],
    });
    const sourceLaps: RecapLapInput[] = lapResult.rows.filter((row) => dashboardLapAttribution(
      row.driver_attribution_stints, session.driver_attribution_stints, row.source_clock_domain,
      row.source_lap_start_ms, row.source_lap_end_ms,
    ) === "Self").map((row) => ({
      id: asNumber(row.id), lapNumber: asNumber(row.lap_number), lapTime: asNumber(row.lap_time),
      classification: row.classification == null ? null : String(row.classification) as LapClassification,
      isValid: Boolean(row.is_valid), sectorTimes: parseJson<number[]>(row.sector_times),
      invalidReason: row.invalid_reason == null ? null : String(row.invalid_reason),
    }));
    const staleSummary = session.deleted === 1 || session.metadata_dirty === 1 || session.capture_dirty === 1
      || session.processor_version == null || session.processor_version !== session.summary_processor_version
      || session.source_revision !== session.summary_source_revision;
    const captureEvidenceCurrent = !staleSummary && session.evidence_version === DASHBOARD_PROCESSOR_VERSION;
    const trackId = session.track_id == null ? "-1" : String(session.track_id);
    const carId = session.car_id == null ? "-1" : String(session.car_id);
    const carKey = dashboardCarIdentity(gameId, session.car_id == null ? null : String(session.car_id));
    const trackKey = dashboardTrackIdentity(gameId, session.track_id == null ? null : String(session.track_id));
    const carSourcePredicate = carKey === null ? "0=1" : "s.car_id=?";
    const trackSourcePredicate = trackKey === null ? "0=1" : "s.track_id=?";
    const carSourceArgs = carKey === null ? [] : [String(session.car_id)];
    const trackSourceArgs = trackKey === null ? [] : [String(session.track_id)];
    const adapter = tryGetGame(gameId);
    const carName = gameId === "lmu" && typeof carId === "string"
      ? getLMUCar(carId)?.name ?? carId
      : adapter ? adapter.getCarName(carId) : resolveCarName(carId, gameId);
    const trackName = gameId === "lmu" && typeof trackId === "string"
      ? getLMUTrack(trackId)?.name ?? trackId
      : adapter ? adapter.getTrackName(trackId) : resolveTrackName(trackId, gameId);
    const trackLengthM = captureEvidenceCurrent ? maybeNumber(session.track_length_meters) : null;

    // Published and raw fallback minima share the same historical Self interval classifier.
    const bestResult = await tx.execute({
      sql: `SELECT MIN(d.best_lap_seconds) AS best FROM dashboard_session_summaries d
        JOIN sessions s ON s.id=d.session_id JOIN dashboard_summary_state st ON st.session_id=d.session_id
        WHERE s.ownership='mine' AND s.game_id=? AND d.session_id!=? AND d.car_key=? AND d.track_key=?
          AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
          AND (s.owner_user_id IS NULL OR s.owner_user_id=(SELECT online_user_id FROM local_account_owner WHERE id=1))
          AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0 AND st.source_revision=st.published_revision
          AND st.processor_version=d.processor_version AND st.processor_version=?`,
      args: [gameId,id,carKey,trackKey,DASHBOARD_PROCESSOR_VERSION],
    });
    let allTimeBestSec = maybeNumber(bestResult.rows[0]?.best);

    let allTimeBestSectors: Array<number | null> | null = null;
    const layoutKey = captureEvidenceCurrent && session.sector_status === "available" ? String(session.sector_layout_key ?? "") : "";
    const sectorCount = captureEvidenceCurrent ? asNumber(session.sector_count ?? 0) : 0;
    if (layoutKey && sectorCount > 0) {
      const sectorResult = await tx.execute({
        sql: `SELECT hs.sector_index,MIN(hs.best_seconds) AS best FROM dashboard_session_sectors hs
          JOIN dashboard_session_summaries h ON h.session_id=hs.session_id JOIN sessions s ON s.id=h.session_id
          JOIN dashboard_summary_state st ON st.session_id=h.session_id
          WHERE s.ownership='mine' AND s.game_id=? AND h.session_id!=? AND h.car_key=? AND h.track_key=? AND hs.layout_key=?
            AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
            AND (s.owner_user_id IS NULL OR s.owner_user_id=(SELECT online_user_id FROM local_account_owner WHERE id=1))
            AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0 AND st.source_revision=st.published_revision
            AND st.processor_version=h.processor_version AND st.processor_version=? AND hs.sector_index<?
          GROUP BY hs.sector_index`,
        args: [gameId,id,carKey,trackKey,layoutKey,DASHBOARD_PROCESSOR_VERSION,sectorCount],
      });
      allTimeBestSectors = new Array<number | null>(sectorCount).fill(null);
      for (const row of sectorResult.rows) allTimeBestSectors[asNumber(row.sector_index)] = asNumber(row.best);
    }
    let afterLapId = 0;
    for (;;) {
      const raw = await tx.execute({
        sql: `SELECT l.id,l.lap_time,l.is_valid,l.invalid_reason,l.sector_times,l.driver_attribution_stints,
            l.source_clock_domain,l.source_lap_start_ms,l.source_lap_end_ms,s.driver_attribution_stints AS session_stints,
            CASE WHEN d.sector_layout_key=? AND d.sector_status='available' AND d.evidence_version=?
              AND st.capture_dirty=0 THEN 1 ELSE 0 END AS sectors_current
          FROM laps l JOIN sessions s ON s.id=l.session_id
          LEFT JOIN dashboard_summary_state st ON st.session_id=s.id
          LEFT JOIN dashboard_session_summaries d ON d.session_id=s.id
          WHERE s.ownership='mine' AND s.game_id=? AND s.id!=? AND ${carSourcePredicate} AND ${trackSourcePredicate}
            AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
            AND (s.owner_user_id IS NULL OR s.owner_user_id=(SELECT online_user_id FROM local_account_owner WHERE id=1))
            AND l.id>? AND l.is_valid=1 AND (l.classification IS NULL OR l.classification='pace') AND l.lap_time>0
            AND (st.session_id IS NULL OR d.session_id IS NULL OR st.metadata_dirty=1 OR st.capture_dirty=1 OR st.deleted=1
              OR st.source_revision!=st.published_revision OR st.processor_version!=? OR d.processor_version!=st.processor_version)
          ORDER BY l.id LIMIT 256`,
        args: [layoutKey,DASHBOARD_PROCESSOR_VERSION,gameId,id,...carSourceArgs,...trackSourceArgs,afterLapId,DASHBOARD_PROCESSOR_VERSION],
      });
      for (const row of raw.rows) {
        afterLapId = asNumber(row.id);
        if (dashboardLapAttribution(row.driver_attribution_stints, row.session_stints, row.source_clock_domain,
          row.source_lap_start_ms, row.source_lap_end_ms) !== "Self") continue;
        const time = asNumber(row.lap_time);
        if (!dashboardLapMetricFlags(time, Boolean(row.is_valid), row.invalid_reason == null ? null : String(row.invalid_reason)).valid) continue;
        allTimeBestSec = allTimeBestSec === null ? time : Math.min(allTimeBestSec, time);
        if (!layoutKey || sectorCount <= 0 || row.sectors_current !== 1) continue;
        const values = parseJson<unknown>(row.sector_times);
        if (!Array.isArray(values) || values.length !== sectorCount
          || !values.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) continue;
        allTimeBestSectors ??= new Array<number | null>(sectorCount).fill(null);
        for (let index = 0; index < sectorCount; index++) {
          const previous = allTimeBestSectors[index];
          allTimeBestSectors[index] = previous == null ? values[index] : Math.min(previous, values[index]);
        }
      }
      if (raw.rows.length < 256) break;
    }
    if (allTimeBestSectors && !allTimeBestSectors.some((value) => value !== null)) allTimeBestSectors = null;
    const recap = computeRecap({
      session: { id, gameId, createdAt: String(session.created_at), carId, trackId, ownership: "mine" },
      laps: sourceLaps, carName, trackName, trackLengthM,
      allTimeBestSec, allTimeBestSectors,
      sectorStarts: captureEvidenceCurrent && session.sector_status === "available" ? parseJson<number[]>(session.source_sector_starts_json) : null,
    });
    const conditions = captureEvidenceCurrent && session.weather_status === "available"
      ? parseJson<{ rainIntensity?: number }>(session.weather_conditions_json) : null;
    if (conditions) recap.weather = {
      kind: null,
      rainPercent: typeof conditions.rainIntensity === "number" ? conditions.rainIntensity * 100 : null,
    };
    await tx.commit();
    return recap;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
