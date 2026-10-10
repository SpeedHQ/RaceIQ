import { client } from "@raceiq/backend-core/db/index";
import type { GameId } from "@raceiq/shared/games/ids";
import type { SessionRecap } from "@raceiq/shared/racing/sessions/types";
import { tryGetGame } from "@raceiq/shared/games/registry";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { getLMUCar, getLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0);
const nullable = (value: unknown) => value == null ? null : Number(value);
const roundoff = (value: number) => value;

/** Metric oracle derives target and historical values directly from source laps, not summaries/reducers. */
export async function sourceRecapMetricOracle(sessionId: number, gameId: GameId): Promise<SessionRecap> {
  const sessionResult = await client.execute({ sql: "SELECT id,game_id,created_at,car_id,track_id,car_ordinal,track_ordinal FROM sessions WHERE id=? AND game_id=?", args: [sessionId, gameId] });
  const session = sessionResult.rows[0];
  if (!session) throw new Error(`Fixture recap session ${sessionId} missing`);
  const sourceRow = session;
  const sourceCarId = typeof sourceRow.car_id === "string" ? sourceRow.car_id : null;
  const sourceTrackId = typeof sourceRow.track_id === "string" ? sourceRow.track_id : null;
  const carOrdinal = nullable(sourceRow.car_ordinal), trackOrdinal = nullable(sourceRow.track_ordinal);
  const carId = sourceCarId ?? carOrdinal ?? -1;
  const trackId = sourceTrackId ?? trackOrdinal ?? -1;
  const adapter = tryGetGame(gameId);
  const carName = gameId === "lmu" && typeof carId === "string" ? getLMUCar(carId)?.name ?? carId
    : adapter ? adapter.getCarName(n(carId)) : resolveCarName(n(carId), gameId);
  const trackName = gameId === "lmu" && typeof trackId === "string" ? getLMUTrack(trackId)?.name ?? trackId
    : adapter ? adapter.getTrackName(n(trackId)) : resolveTrackName(n(trackId), gameId);
  const lapsResult = await client.execute({ sql: "SELECT id,lap_number,lap_time,is_valid,invalid_reason,sector_times FROM laps WHERE session_id=? ORDER BY lap_number,id", args: [sessionId] });
  const laps = (lapsResult.rows as Row[]).map((row) => ({
    id: n(row.id), lapNumber: n(row.lap_number), lapTime: n(row.lap_time), isValid: Boolean(row.is_valid),
    invalidReason: row.invalid_reason == null ? null : String(row.invalid_reason),
    sectors: row.sector_times == null ? null : JSON.parse(String(row.sector_times)) as number[],
  }));
  const valid = laps.filter((lap) => lap.isValid && lap.lapTime > 0);
  const lapTimes = valid.map((lap) => lap.lapTime);
  const best = valid.reduce<(typeof valid)[number] | null>((current, lap) => !current || lap.lapTime < current.lapTime ? lap : current, null);
  const historical = await client.execute({ sql: `SELECT MIN(l.lap_time) best FROM laps l JOIN sessions s ON s.id=l.session_id
    WHERE s.ownership='mine' AND s.game_id=? AND s.id!=? AND s.car_id IS ? AND s.track_id IS ?
      AND l.is_valid=1 AND l.lap_time>0`, args: [gameId, sessionId, sourceCarId, sourceTrackId] });
  const previousBestSec = nullable((historical.rows[0] as Row | undefined)?.best);
  const validSectorLaps = valid.filter((lap) => lap.sectors && lap.sectors.length >= 2 && lap.sectors.every((time) => time > 0));
  const sectorCount = validSectorLaps[0]?.sectors?.length ?? 0;
  const sessionBests = sectorCount ? Array.from({ length: sectorCount }, (_, index) => Math.min(...validSectorLaps.filter((lap) => lap.sectors!.length === sectorCount).map((lap) => lap.sectors![index]!))) : null;
  const sectorStarts = Number(sourceRow.track_ordinal) === 0 ? [0, 1 / 3, 2 / 3] : null;
  const historicalSectors = sectorCount ? await client.execute({ sql: `SELECT json_each.key sector_index,MIN(CAST(json_each.value AS REAL)) best
    FROM sessions s JOIN laps l ON l.session_id=s.id, json_each(l.sector_times)
    WHERE s.ownership='mine' AND s.game_id=? AND s.id!=? AND s.car_id IS ? AND s.track_id IS ?
      AND l.is_valid=1 AND l.lap_time>0 AND CAST(json_each.key AS INTEGER)<?
    GROUP BY json_each.key`, args: [gameId, sessionId, sourceCarId, sourceTrackId, sectorCount] }) : { rows: [] };
  const allTimeBestSectors = sectorCount ? Array.from({ length: sectorCount }, (_, index) => {
    const row = (historicalSectors.rows as Row[]).find((candidate) => n(candidate.sector_index) === index);
    return nullable(row?.best);
  }) : null;
  const stddev = lapTimes.length ? Math.sqrt(lapTimes.reduce((sum, lapTime) => sum + (lapTime - lapTimes.reduce((total, value) => total + value, 0) / lapTimes.length) ** 2, 0) / lapTimes.length) : 0;
  let consistency: SessionRecap["consistency"] = null;
  if (lapTimes.length >= 3 && best) {
    const ratio = stddev / best.lapTime;
    consistency = { stdDevSec: roundoff(stddev), rating: best.lapTime <= 0 ? 1 : ratio < 0.01 ? 5 : ratio < 0.02 ? 4 : ratio < 0.04 ? 3 : ratio < 0.07 ? 2 : 1 };
  }
  const theoretical = sessionBests && best ? { bestSectorTimes: sessionBests, sumSec: sessionBests.reduce((sum, value) => sum + value, 0), deltaToBestSec: Math.max(0, best.lapTime - sessionBests.reduce((sum, value) => sum + value, 0)) } : null;
  const sectors = theoretical && sessionBests && best ? sessionBests.map((sessionBestSec, index) => {
    const bestLapSec = best.sectors?.length === sectorCount && best.sectors.every((value) => value > 0) ? best.sectors[index]! : sessionBestSec;
    const allTimeBestSec = allTimeBestSectors?.[index] ?? null;
    return { index: index + 1, bestLapSec, sessionBestSec, allTimeBestSec,
      status: allTimeBestSec === null || sessionBestSec < allTimeBestSec ? "record" as const
        : best.sectors?.length !== sectorCount ? "session-best" as const
          : Math.abs(bestLapSec - sessionBestSec) < 1e-6 ? "session-best" as const : "lost" as const };
  }) : null;
  return {
    sessionId, gameId, carName, trackName, carId, trackId, createdAt: String(sourceRow.created_at),
    lapsTotal: laps.length, lapsValid: valid.length, bestLapSec: best?.lapTime ?? null, bestLapId: best?.id ?? null,
    timeOnTrackSec: lapTimes.reduce((sum, lapTime) => sum + lapTime, 0), distanceM: null,
    sparkline: laps.map((lap) => ({ lapId: lap.id, lapNumber: lap.lapNumber, lapTimeSec: lap.lapTime, isValid: lap.isValid && lap.lapTime > 0 })),
    improvementSec: valid.length >= 2 && best ? Math.max(0, valid.reduce((first, lap) => lap.lapNumber < first.lapNumber ? lap : first, valid[0]!).lapTime - best.lapTime) : null,
    consistency, personalBest: best ? { isNew: previousBestSec === null || best.lapTime < previousBestSec, previousBestSec } : null,
    theoretical, sectors, sectorStarts: sectors ? sectorStarts : null,
  };
}
