import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionRecap } from "@raceiq/shared/racing/sessions/types";
import { dashboardCarIdentity, dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import { computeRecap, type RecapLapInput } from "../lap-analysis/recap";
import { getLMUCar, getLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { DASHBOARD_PROCESSOR_VERSION } from "./dashboard-summary-queries";
import { client } from "./index";

const asNumber = (value: unknown): number => Number(value);
const maybeNumber = (value: unknown): number | null => value == null ? null : asNumber(value);
const parseJson = <T>(value: unknown): T | null => {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as T; } catch { return null; }
};

function sqliteCanonicalIdentity(nativeColumn: string, ordinalColumn: string): string {
  const native = `TRIM(${nativeColumn})`;
  const numeric = `(${native} NOT GLOB '*[^0-9]*' OR (json_valid(${native}) AND json_type(${native}) IN ('integer','real')))`;
  const numericValue = `CAST(${native} AS REAL)`;
  return `CASE
    WHEN ${nativeColumn} IS NULL OR ${native}='' OR (${numeric} AND ${numericValue}=-1)
      THEN CASE WHEN ${ordinalColumn} IS NOT NULL AND ${ordinalColumn}!=-1 THEN 'n:'||${ordinalColumn} ELSE NULL END
    WHEN ${numeric} AND ${numericValue}=CAST(${native} AS INTEGER)
      THEN 'n:'||CAST(CAST(${native} AS INTEGER) AS TEXT)
    ELSE 's:'||${nativeColumn} END`;
}

function canonicalIdentityPart(key: string | null): string | null {
  return key === null ? null : JSON.parse(key)[1] as string;
}

/** Capture-free, exact-mine dashboard recap. Returns null for unavailable sessions. */
export async function getDashboardSessionRecap(id: number, gameId: GameId): Promise<SessionRecap | null> {
  const tx = await client.transaction("read");
  try {
    const selected = await tx.execute({
      sql: `SELECT s.id,s.game_id,s.created_at,s.car_id,s.car_ordinal,s.track_id,s.track_ordinal,
          p.source_revision,p.published_revision,p.processor_version,p.metadata_dirty,p.capture_dirty,p.deleted,
          d.source_revision AS summary_source_revision,d.processor_version AS summary_processor_version,d.evidence_version,
          d.best_lap_seconds,d.track_length_meters,d.sector_layout_key,d.sector_count,d.sector_status,
          d.weather_status,d.weather_conditions_json,d.source_sector_starts_json
        FROM sessions s LEFT JOIN dashboard_summary_state p ON p.session_id=s.id
        LEFT JOIN dashboard_session_summaries d ON d.session_id=s.id
        WHERE s.id=? AND s.game_id=? AND s.ownership='mine'`, args: [id, gameId],
    });
    const session = selected.rows[0];
    if (!session) { await tx.commit(); return null; }
    const lapResult = await tx.execute({
      sql: `SELECT id,lap_number,lap_time,is_valid,sector_times,invalid_reason FROM laps
        WHERE session_id=? ORDER BY lap_number,id`, args: [id],
    });
    const sourceLaps: RecapLapInput[] = lapResult.rows.map((row) => ({
      id: asNumber(row.id), lapNumber: asNumber(row.lap_number), lapTime: asNumber(row.lap_time),
      isValid: Boolean(row.is_valid), sectorTimes: parseJson<number[]>(row.sector_times),
      invalidReason: row.invalid_reason == null ? null : String(row.invalid_reason),
    }));
    const staleSummary = session.deleted === 1 || session.metadata_dirty === 1 || session.capture_dirty === 1
      || session.processor_version == null || session.processor_version !== session.summary_processor_version
      || session.source_revision !== session.summary_source_revision;
    const captureEvidenceCurrent = !staleSummary && session.evidence_version === DASHBOARD_PROCESSOR_VERSION;
    const carOrdinal = maybeNumber(session.car_ordinal);
    const trackOrdinal = maybeNumber(session.track_ordinal);
    const trackId = session.track_id == null ? trackOrdinal ?? -1 : String(session.track_id);
    const carId = session.car_id == null ? carOrdinal ?? -1 : String(session.car_id);
    const carKey = dashboardCarIdentity(gameId, session.car_id == null ? null : String(session.car_id), carOrdinal);
    const trackKey = dashboardTrackIdentity(gameId, session.track_id == null ? null : String(session.track_id), trackOrdinal);
    const carSourcePredicate = carKey === null ? "0=1" : `${sqliteCanonicalIdentity("s.car_id", "s.car_ordinal")}=?`;
    const trackSourcePredicate = trackKey === null ? "0=1" : `${sqliteCanonicalIdentity("s.track_id", "s.track_ordinal")}=?`;
    const carSourceArgs = carKey === null ? [] : [canonicalIdentityPart(carKey)];
    const trackSourceArgs = trackKey === null ? [] : [canonicalIdentityPart(trackKey)];
    const adapter = tryGetGame(gameId);
    const carName = gameId === "lmu" && typeof carId === "string"
      ? getLMUCar(carId)?.name ?? carId
      : adapter ? adapter.getCarName(asNumber(carId)) : resolveCarName(asNumber(carId), gameId);
    const trackName = gameId === "lmu" && typeof trackId === "string"
      ? getLMUTrack(trackId)?.name ?? trackId
      : adapter ? adapter.getTrackName(asNumber(trackId)) : resolveTrackName(asNumber(trackId), gameId);
    const trackLengthM = captureEvidenceCurrent ? maybeNumber(session.track_length_meters) : null;

    // Clean published summaries provide indexed historical minima. Dirty/missing rows are
    // reconciled directly from source in one bounded SQL statement; ownership is checked
    // against the live parent row, never trusted from the derived snapshot.
    const bestResult = await tx.execute({
      sql: `SELECT MIN(best_seconds) AS best FROM (
          SELECT d.best_lap_seconds AS best_seconds FROM dashboard_session_summaries d
          JOIN sessions s ON s.id=d.session_id JOIN dashboard_summary_state st ON st.session_id=d.session_id
          WHERE s.ownership='mine' AND s.game_id=? AND d.session_id!=? AND d.car_key=? AND d.track_key=?
            AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0 AND st.source_revision=st.published_revision AND st.processor_version=d.processor_version AND st.processor_version=?
          UNION ALL
          SELECT l.lap_time FROM laps l JOIN sessions s ON s.id=l.session_id
          LEFT JOIN dashboard_summary_state st ON st.session_id=s.id
          WHERE s.ownership='mine' AND s.game_id=? AND s.id!=?
            AND ${carSourcePredicate}
            AND ${trackSourcePredicate}
            AND l.is_valid=1 AND l.lap_time>0 AND (st.session_id IS NULL OR st.metadata_dirty=1 OR st.capture_dirty=1 OR st.deleted=1 OR st.source_revision!=st.published_revision OR st.processor_version!=?)
        )`,
      args: [gameId,id,carKey,trackKey,DASHBOARD_PROCESSOR_VERSION,gameId,id,...carSourceArgs,...trackSourceArgs,DASHBOARD_PROCESSOR_VERSION],
    });
    const allTimeBestSec = maybeNumber(bestResult.rows[0]?.best);

    let allTimeBestSectors: Array<number | null> | null = null;
    const layoutKey = captureEvidenceCurrent && session.sector_status === "available" ? String(session.sector_layout_key ?? "") : "";
    const sectorCount = captureEvidenceCurrent ? asNumber(session.sector_count ?? 0) : 0;
    if (layoutKey && sectorCount > 0) {
      const sectorResult = await tx.execute({
        sql: `SELECT sector_index,MIN(best_seconds) AS best FROM (
            SELECT hs.sector_index,hs.best_seconds FROM dashboard_session_sectors hs
            JOIN dashboard_session_summaries h ON h.session_id=hs.session_id JOIN sessions s ON s.id=h.session_id
            JOIN dashboard_summary_state st ON st.session_id=h.session_id
            WHERE s.ownership='mine' AND s.game_id=? AND h.session_id!=? AND h.car_key=? AND h.track_key=? AND hs.layout_key=?
              AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0 AND st.source_revision=st.published_revision AND st.processor_version=h.processor_version AND st.processor_version=?
            UNION ALL
            SELECT json_each.key AS sector_index,CAST(json_each.value AS REAL) AS best_seconds FROM laps l JOIN sessions s ON s.id=l.session_id
            LEFT JOIN dashboard_summary_state st ON st.session_id=s.id, json_each(l.sector_times)
            WHERE s.ownership='mine' AND s.game_id=? AND s.id!=?
              AND ${carSourcePredicate}
              AND ${trackSourcePredicate}
              AND l.is_valid=1 AND l.lap_time>0 AND (st.session_id IS NULL OR st.metadata_dirty=1 OR st.capture_dirty=1 OR st.deleted=1 OR st.source_revision!=st.published_revision OR st.processor_version!=?)
              AND EXISTS(SELECT 1 FROM dashboard_session_summaries hd JOIN dashboard_summary_state hst ON hst.session_id=hd.session_id
                WHERE hd.session_id=s.id AND hd.sector_layout_key=? AND hd.sector_status='available' AND hd.evidence_version=? AND hst.capture_dirty=0)
          ) WHERE CAST(sector_index AS INTEGER) < ? GROUP BY sector_index`,
        args: [gameId,id,carKey,trackKey,layoutKey,DASHBOARD_PROCESSOR_VERSION,gameId,id,...carSourceArgs,...trackSourceArgs,DASHBOARD_PROCESSOR_VERSION,layoutKey,DASHBOARD_PROCESSOR_VERSION,sectorCount],
      });
      allTimeBestSectors = new Array<number | null>(sectorCount).fill(null);
      for (const row of sectorResult.rows) allTimeBestSectors[asNumber(row.sector_index)] = asNumber(row.best);
      if (!allTimeBestSectors.some((value) => value !== null)) allTimeBestSectors = null;
    }
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
