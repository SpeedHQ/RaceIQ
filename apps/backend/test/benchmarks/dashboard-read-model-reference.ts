import { client } from "@raceiq/backend-core/db/index";
import { dashboardCarIdentity, dashboardTrackIdentity, type DashboardRequest, type DashboardResponse, type DashboardEntityTotal, type DashboardFavourite, type DashboardSessionType } from "@raceiq/shared/racing/sessions/dashboard";
import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { resolveLMUCar, resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v ?? 0);
const nullable = (v: unknown): number | null => v == null ? null : Number(v);
const sqlRows = (result: { rows: unknown[] }) => result.rows as Row[];
const entityIdentity = (gameId: GameId, raw: string | null, kind: "car" | "track", ordinal: number) => kind === "car"
  ? dashboardCarIdentity(gameId, raw, ordinal) ?? "" : dashboardTrackIdentity(gameId, raw, ordinal) ?? "";

function sourceEntityName(row: Row, gameId: GameId, kind: "car" | "track"): string | null {
  const nativeId = row[kind === "car" ? "car_id" : "track_id"];
  const ordinal = nullable(row[kind === "car" ? "car_ordinal" : "track_ordinal"]);
  const id = typeof nativeId === "string" ? nativeId.trim() : nativeId;
  if (gameId === "lmu" && typeof id === "string" && id !== "" && !Number.isFinite(Number(id))) {
    return (kind === "car" ? resolveLMUCar(id)?.name : resolveLMUTrack(id)?.name) ?? id;
  }
  const numericId = id != null && id !== "" ? Number(id) : null;
  const resolvedOrdinal = numericId != null && Number.isInteger(numericId) && numericId >= 0 ? numericId : ordinal;
  if (resolvedOrdinal == null || !Number.isInteger(resolvedOrdinal) || resolvedOrdinal < 0) return null;
  return kind === "car" ? resolveCarName(resolvedOrdinal, gameId) : resolveTrackName(resolvedOrdinal, gameId);
}
type PodiumFacts = { count: number; evidence: number };
function rank(rows: Row[], kind: "car" | "track", favourite: boolean, podiums: ReadonlyMap<string, PodiumFacts>): Array<DashboardFavourite & { laps: number }> {
  const byIdentity = new Map<string, DashboardFavourite & { laps: number }>();
  for (const row of rows) {
    const gameId = String(row.game_id) as GameId;
    const id = kind === "car" ? row.car_id : row.track_id;
    const raw = id == null ? null : String(id);
    const ordinal = n(kind === "car" ? row.car_ordinal : row.track_ordinal);
    const identity = entityIdentity(gameId, raw, kind, ordinal);
    if (!identity) continue;
    const numericId = raw !== null && /^-?\d+(?:\.\d+)?$/.test(raw);
    const resolvedOrdinal = numericId ? Number(raw) : raw === null && ordinal !== -1 ? ordinal : null;
    const nativeId = numericId ? Number(raw) : raw === null && ordinal !== -1 ? ordinal : raw;
    const seconds = n(favourite ? row.favourite_seconds : row.driven_seconds);
    const laps = n(favourite ? row.favourite_laps : row.positive_laps);
    const podiumFacts = podiums.get(identity);
    const current = byIdentity.get(identity) ?? { gameId, identity, nativeId, ordinal: resolvedOrdinal, seconds: 0, laps: 0, sessions: 0, distanceMeters: null, distanceLaps: 0,
      podiums: podiumFacts?.evidence ? podiumFacts.count : null };
    current.seconds += seconds; current.laps += laps; current.sessions += n(row.sessions);
    byIdentity.set(identity, current);
  }
  return [...byIdentity.values()].filter((row) => row.laps > 0).sort((a, b) => b.seconds - a.seconds || b.laps - a.laps
    || a.gameId.localeCompare(b.gameId) || a.identity.localeCompare(b.identity));
}
function asEntity(item: DashboardFavourite & { laps: number }, total: number): DashboardEntityTotal {
  return { gameId: item.gameId, identity: item.identity, ordinal: item.ordinal, seconds: item.seconds, share: total ? item.seconds / total : 0 };
}

/** SQL reference reads only source sessions, laps, results, and explicit fixture evidence. */
export async function sourceDashboardReference(request: DashboardRequest): Promise<DashboardResponse> {
  const from = Date.parse(request.from), to = Date.parse(request.to);
  const fromText = new Date(from).toISOString(), toText = new Date(to).toISOString();
  const bind = [from, to, from, to, ...(request.gameId ? [request.gameId] : [])];
  const whereScope = request.gameId ? " AND si.game_id=?" : "";
  const sessionScope = request.gameId ? " AND si.game_id=?" : "";
  const sourceLaps = sqlRows(await client.execute({ sql: `SELECT s.game_id,s.car_id,s.car_ordinal,s.track_id,s.track_ordinal,
      COUNT(l.id) lap_count,SUM(l.lap_time>0) positive_laps,SUM(l.is_valid=1 AND l.lap_time>0) valid_laps,
      SUM(CASE WHEN l.lap_time>0 THEN l.lap_time ELSE 0 END) driven_seconds,
      SUM(CASE WHEN l.is_valid=1 AND l.lap_time>0 THEN l.lap_time ELSE 0 END) valid_seconds,
      SUM(l.lap_time>0 AND COALESCE(l.invalid_reason,'')!='incomplete') favourite_laps,
      SUM(CASE WHEN l.lap_time>0 AND COALESCE(l.invalid_reason,'')!='incomplete' THEN l.lap_time ELSE 0 END) favourite_seconds,
      COUNT(DISTINCT l.session_id) sessions
    FROM laps l JOIN dashboard_lap_index li ON li.lap_id=l.id JOIN sessions s ON s.id=l.session_id
    JOIN dashboard_session_index si ON si.session_id=s.id
    WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<? AND li.created_at_ms>=? AND li.created_at_ms<?${whereScope}
    GROUP BY s.game_id,s.car_id,s.car_ordinal,s.track_id,s.track_ordinal`, args: bind }));
  const totalRows = sqlRows(await client.execute({ sql: `SELECT COUNT(l.id) laps,SUM(l.lap_time>0) positive_laps,
      SUM(l.is_valid=1 AND l.lap_time>0) valid_laps,SUM(CASE WHEN l.lap_time>0 THEN l.lap_time ELSE 0 END) driven_seconds,
      SUM(CASE WHEN l.is_valid=1 AND l.lap_time>0 THEN l.lap_time ELSE 0 END) valid_seconds,
      MIN(CASE WHEN l.is_valid=1 AND l.lap_time>0 THEN l.lap_time END) best_lap_seconds,
      COUNT(DISTINCT s.game_id||':'||s.track_id) tracks,COUNT(DISTINCT s.game_id||':'||s.car_id) cars,
      COUNT(DISTINCT s.id) sessions
    FROM laps l JOIN dashboard_lap_index li ON li.lap_id=l.id JOIN sessions s ON s.id=l.session_id
      JOIN dashboard_session_index si ON si.session_id=s.id WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
      AND li.created_at_ms>=? AND li.created_at_ms<?${whereScope}`, args: bind }));
  const totals = totalRows[0] ?? {};
  const cards = Object.fromEntries(KNOWN_GAME_IDS.map((gameId) => [gameId, { laps: 0, drivenSeconds: 0 }])) as DashboardResponse["cards"];
  const entityPodiumRows = sqlRows(await client.execute({ sql: `SELECT s.game_id,s.car_id,s.car_ordinal,s.track_id,s.track_ordinal,
      COUNT(DISTINCT CASE WHEN r.finishing_position IN (1,2,3) THEN s.id END) podiums,COUNT(DISTINCT s.id) evidence
    FROM session_results r JOIN sessions s ON s.id=r.session_id
    WHERE s.ownership='mine'
      AND CAST(strftime('%s',s.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',s.created_at),4,3) AS INTEGER)>=?
      AND CAST(strftime('%s',s.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',s.created_at),4,3) AS INTEGER)<?
      AND lower(trim(s.session_type)) LIKE 'race%' AND r.outcome_status='confirmed' AND r.classification='finished'
      AND r.finishing_position>0 AND r.finishing_position=CAST(r.finishing_position AS INTEGER)${request.gameId ? " AND s.game_id=?" : ""}
    GROUP BY s.game_id,s.car_id,s.car_ordinal,s.track_id,s.track_ordinal`,
    args: [from, to, ...(request.gameId ? [request.gameId] : [])] }));
  const carPodiums = new Map<string, PodiumFacts>(), trackPodiums = new Map<string, PodiumFacts>();
  for (const row of entityPodiumRows) {
    const gameId = String(row.game_id) as GameId;
    const carIdentity = entityIdentity(gameId, row.car_id == null ? null : String(row.car_id), "car", n(row.car_ordinal));
    const trackIdentity = entityIdentity(gameId, row.track_id == null ? null : String(row.track_id), "track", n(row.track_ordinal));
    for (const [podiumMap, identity] of [[carPodiums, carIdentity], [trackPodiums, trackIdentity]] as const) {
      const current = podiumMap.get(identity) ?? { count: 0, evidence: 0 };
      current.count += n(row.podiums); current.evidence += n(row.evidence);
      podiumMap.set(identity, current);
    }
  }
  const tracks = rank(sourceLaps, "track", false, trackPodiums), cars = rank(sourceLaps, "car", false, carPodiums);
  const favouriteTracks = rank(sourceLaps, "track", true, trackPodiums), favouriteCars = rank(sourceLaps, "car", true, carPodiums);
  const cardRows = sqlRows(await client.execute({
    sql: `SELECT s.game_id,COUNT(l.id) lap_count,
        SUM(CASE WHEN l.lap_time>0 THEN l.lap_time ELSE 0 END) driven_seconds
      FROM laps l JOIN sessions s ON s.id=l.session_id
      WHERE s.ownership='mine' AND julianday(l.created_at)>=julianday(?) AND julianday(l.created_at)<julianday(?)
      GROUP BY s.game_id`,
    args: [fromText, toText],
  }));
  for (const row of cardRows) {
    const card = cards[String(row.game_id) as GameId];
    card.laps += n(row.lap_count); card.drivenSeconds += n(row.driven_seconds);
  }
  const distributionTracks = [...tracks].sort((a, b) => b.seconds - a.seconds || a.gameId.localeCompare(b.gameId) || a.identity.localeCompare(b.identity));
  const totalTrackSeconds = distributionTracks.reduce((sum, item) => sum + item.seconds, 0);
  const othersSeconds = distributionTracks.slice(5).reduce((sum, row) => sum + row.seconds, 0);
  const trackTotal: DashboardResponse["trackDistribution"] = {
    totalSeconds: totalTrackSeconds, topFive: distributionTracks.slice(0, 5).map((row) => asEntity(row, totalTrackSeconds)),
    othersSeconds, othersShare: totalTrackSeconds ? othersSeconds / totalTrackSeconds : 0, othersCount: Math.max(0, distributionTracks.length - 5),
  };
  const consistencyRow = sqlRows(await client.execute({ sql: `WITH per_session AS (
      SELECT s.id,COUNT(*) n,AVG(l.lap_time) mean,AVG(l.lap_time*l.lap_time)-AVG(l.lap_time)*AVG(l.lap_time) variance
      FROM sessions s JOIN dashboard_session_index si ON si.session_id=s.id
      JOIN laps l ON l.session_id=s.id JOIN dashboard_lap_index li ON li.lap_id=l.id
      WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<? AND li.created_at_ms>=? AND li.created_at_ms<?
        AND l.is_valid=1 AND l.lap_time>0 AND s.car_ordinal!=-1 AND s.track_ordinal!=-1${sessionScope}
      GROUP BY s.id HAVING COUNT(*)>=2
    ), deviations AS (SELECT sqrt(MAX(variance,0)) sd FROM per_session)
    SELECT COUNT(*) sessions,AVG(sd) average_sd,
      SUM(sd<0.1) b0,SUM(sd>=0.1 AND sd<0.2) b1,SUM(sd>=0.2 AND sd<0.5) b2,
      SUM(sd>=0.5 AND sd<1) b3,SUM(sd>=1 AND sd<2) b4,SUM(sd>=2 AND sd<=5) b5,SUM(sd>5) b6 FROM deviations`, args: bind }))[0] ?? {};
  const consistency: DashboardResponse["consistency"] = { sessions: n(consistencyRow.sessions), averageStandardDeviation: nullable(consistencyRow.average_sd),
    deviations: Array.from({ length: 7 }, (_, i) => n(consistencyRow[`b${i}`])) };
  const recent = sqlRows(await client.execute({ sql: `SELECT s.id,s.game_id,s.created_at,s.session_type,s.car_id,s.car_ordinal,s.track_id,s.track_ordinal,
      COUNT(l.id) lap_count,MIN(CASE WHEN l.is_valid=1 AND l.lap_time>0 THEN l.lap_time END) best_lap_seconds
    FROM sessions s JOIN dashboard_session_index si ON si.session_id=s.id LEFT JOIN laps l ON l.session_id=s.id
    WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?${sessionScope}
    GROUP BY s.id ORDER BY si.created_at_ms DESC,s.id DESC LIMIT 10`, args: [from, to, ...(request.gameId ? [request.gameId] : [])] }));
  const recentSessions: DashboardResponse["recentSessions"] = recent.map((row) => ({
    id: n(row.id), gameId: String(row.game_id) as GameId, createdAt: new Date(String(row.created_at).replace(" ", "T") + (String(row.created_at).endsWith("Z") ? "" : "Z")).toISOString(),
    sessionType: row.session_type == null ? null : String(row.session_type),
    car: { id: row.car_id == null ? null : String(row.car_id), ordinal: nullable(row.car_ordinal), name: sourceEntityName(row, String(row.game_id) as GameId, "car") },
    track: { id: row.track_id == null ? null : String(row.track_id), ordinal: nullable(row.track_ordinal), name: sourceEntityName(row, String(row.game_id) as GameId, "track") },
    lapCount: n(row.lap_count), bestLapSeconds: nullable(row.best_lap_seconds),
  }));
  const calendarRows = sqlRows(await client.execute({ sql: `SELECT date(li.created_at_ms/1000,'unixepoch') day,
      SUM(l.is_valid=1 AND l.lap_time>0) valid_laps,SUM(l.lap_time>0) positive_laps,
      SUM(CASE WHEN l.lap_time>0 THEN l.lap_time ELSE 0 END) driven_seconds
    FROM laps l JOIN dashboard_lap_index li ON li.lap_id=l.id JOIN dashboard_session_index si ON si.session_id=l.session_id
    WHERE si.ownership='mine' AND li.created_at_ms>=? AND li.created_at_ms<?${whereScope}
    GROUP BY day ORDER BY day`, args: [from, to, ...(request.gameId ? [request.gameId] : [])] }));
  const calendarByDay = new Map(calendarRows.map((row) => [String(row.day), row]));
  const days: DashboardResponse["calendar"] = [];
  for (let stamp = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()); stamp < to && days.length < 367; stamp += 86_400_000) {
    const day = new Date(stamp).toISOString().slice(0, 10), row = calendarByDay.get(day);
    const bucketFrom = Math.max(from, stamp), bucketTo = Math.min(to, stamp + 86_400_000);
    const valid = n(row?.valid_laps), positive = n(row?.positive_laps);
    const resultRows = sqlRows(await client.execute({ sql: `SELECT COUNT(*) podiums FROM session_results r
      JOIN dashboard_session_index si ON si.session_id=r.session_id
      WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<? AND date(si.created_at_ms/1000,'unixepoch')=?
      AND lower(trim(si.session_type)) LIKE 'race%' AND r.outcome_status='confirmed' AND r.classification='finished'
      AND r.finishing_position>0 AND r.finishing_position=CAST(r.finishing_position AS INTEGER)
      AND r.finishing_position IN (1,2,3)${whereScope}`,
      args: [from, to, day, ...(request.gameId ? [request.gameId] : [])] }));
    days.push({ day, from: new Date(bucketFrom).toISOString(), to: new Date(bucketTo).toISOString(), validLaps: valid, positiveLaps: positive,
      cleanRate: positive ? valid / positive : null, drivenSeconds: n(row?.driven_seconds), podiums: n(resultRows[0]?.podiums) });
  }
  const coverage = sqlRows(await client.execute({ sql: `SELECT COUNT(*) mine_sessions,MAX(st.source_revision) revision,
      SUM(CASE WHEN st.session_id IS NOT NULL AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0
      AND st.processor_version=5 AND p.processor_version=5 AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision THEN 1 ELSE 0 END) ready_sessions
    FROM sessions s JOIN dashboard_session_index si ON si.session_id=s.id
      LEFT JOIN dashboard_summary_state st ON st.session_id=s.id LEFT JOIN dashboard_session_summaries p ON p.session_id=s.id
    WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?${sessionScope}`, args: [from, to, ...(request.gameId ? [request.gameId] : [])] }))[0] ?? {};
  const podiumRows = sqlRows(await client.execute({ sql: `SELECT COUNT(DISTINCT CASE WHEN r.finishing_position=1 THEN s.id END) firsts,
      COUNT(DISTINCT CASE WHEN r.finishing_position=2 THEN s.id END) seconds,
      COUNT(DISTINCT CASE WHEN r.finishing_position=3 THEN s.id END) thirds,COUNT(DISTINCT s.id) evidence FROM session_results r JOIN sessions s ON s.id=r.session_id
      WHERE s.ownership='mine'
        AND CAST(strftime('%s',s.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',s.created_at),4,3) AS INTEGER)>=?
        AND CAST(strftime('%s',s.created_at) AS INTEGER)*1000+CAST(substr(strftime('%f',s.created_at),4,3) AS INTEGER)<?
        AND lower(trim(s.session_type)) LIKE 'race%' AND r.outcome_status='confirmed' AND r.classification='finished'
        AND r.finishing_position>0 AND r.finishing_position=CAST(r.finishing_position AS INTEGER)${request.gameId ? " AND s.game_id=?" : ""}`,
    args: [from, to, ...(request.gameId ? [request.gameId] : [])] }))[0] ?? {};
  const mineSessions = n(coverage.mine_sessions), readySessions = n(coverage.ready_sessions);
  const sessionTypes: DashboardResponse["sessionTypes"] = { shares: (["practice", "qualifying", "race", "unknown"] as DashboardSessionType[]).map((kind) => ({ kind, seconds: 0, share: 0 })),
    totalSeconds: 0, unknownSeconds: 0, unknownShare: 0, sessionsWithDuration: 0, sessionsWithoutDuration: mineSessions };
  const first = n(podiumRows.firsts), second = n(podiumRows.seconds), third = n(podiumRows.thirds);
  const totalsOut: DashboardResponse["totals"] = { laps: n(totals.laps), positiveLaps: n(totals.positive_laps), validLaps: n(totals.valid_laps),
    drivenSeconds: n(totals.driven_seconds), validSeconds: n(totals.valid_seconds), bestLapSeconds: nullable(totals.best_lap_seconds),
    averageLapSeconds: n(totals.valid_laps) ? n(totals.valid_seconds) / n(totals.valid_laps) : null,
    tracks: tracks.length, cars: cars.length, sessions: n(totals.sessions) };
  const response: DashboardResponse = { request, revision: n(coverage.revision),
    coverage: { status: readySessions === mineSessions ? "complete" : "pending", metadataComplete: readySessions === mineSessions, mineSessions, readySessions, pendingSessions: mineSessions - readySessions },
    cards, totals: totalsOut, calendar: days, trackDistribution: trackTotal,
    favouriteTrack: favouriteTracks[0] ?? null, favouriteCar: favouriteCars[0] ?? null, consistency, sessionTypes,
    podiums: { total: first + second + third, first, second, third, available: n(podiumRows.evidence) > 0 },
    recentSessions, latestRecapSessionId: recentSessions[0]?.id ?? null };
  return response;
}
