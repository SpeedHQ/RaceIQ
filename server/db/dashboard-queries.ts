import { Database } from "bun:sqlite";
import { DASHBOARD_PROCESSOR_VERSION } from "./dashboard-summary-queries";
import { DB_PATH } from "./index";
import { dashboardCarIdentity, dashboardTrackIdentity, validateDashboardRequest } from "@raceiq/shared/racing/sessions/dashboard";
import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";
import type { DashboardRequest, DashboardResponse, DashboardMetricTotals, DashboardCardTotal, DashboardCalendarBucket, DashboardEntityTotal, DashboardFavourite, DashboardSessionType } from "@raceiq/shared/racing/sessions/dashboard";

const DAY_MS = 86_400_000;
const BUCKET_MS = 900_000;
const MAX_FALLBACK_SESSIONS = 128;
type Row = Record<string, unknown>;

const n = (value: unknown): number => Number(value ?? 0);
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const instant = (value: string): number => Date.parse(value);
let dashboardDatabase: Database | null = null;

function getDashboardDatabase(): Database {
  if (process.env.DB_IN_MEMORY === "1") {
    throw new Error("Dashboard reads require a file-backed SQLite database; DB_IN_MEMORY=1 is unsupported");
  }
  if (!dashboardDatabase) {
    dashboardDatabase = new Database(DB_PATH, { readonly: true });
    dashboardDatabase.exec("PRAGMA busy_timeout=5000");
  }
  return dashboardDatabase;
}
type DashboardQueryObserver = (sql: string, args: (string | number | null)[], rows: unknown[], elapsedMs: number) => void;
let dashboardQueryObserver: DashboardQueryObserver | undefined;

export function setDashboardQueryObserver(observer?: DashboardQueryObserver): void {
  dashboardQueryObserver = observer;
}

export interface DashboardReadCoverage {
  status: "complete" | "pending" | "unavailable";
  metadataComplete: boolean;
  mineSessions: number;
  readySessions: number;
  pendingSessions: number;
}

function assertRequest(request: DashboardRequest): { from: number; to: number } {
  if (!validateDashboardRequest(request)) throw new RangeError("Invalid dashboard request");
  return { from: instant(request.from), to: instant(request.to) };
}
function scope(gameId: GameId | undefined, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return { predicate: gameId ? ` AND ${prefix}game_id=?` : "", args: gameId ? [gameId] : [] };
}


function emptyDashboard(request: DashboardRequest, coverage: DashboardReadCoverage): DashboardResponse {
  const cards = Object.fromEntries(KNOWN_GAME_IDS.map((gameId) => [gameId, { laps: 0, drivenSeconds: 0 }])) as Record<GameId, DashboardCardTotal>;
  const totals: DashboardMetricTotals = {
    laps: 0, positiveLaps: 0, validLaps: 0, drivenSeconds: 0, validSeconds: 0,
    bestLapSeconds: null, averageLapSeconds: null, tracks: 0, cars: 0, sessions: 0,
  };
  const start = Date.parse(request.from), end = Date.parse(request.to);
  const firstDate = new Date(Math.floor(start / DAY_MS) * DAY_MS);
  const dayCount = Math.ceil((end - firstDate.getTime()) / DAY_MS);
  const calendar: DashboardCalendarBucket[] = [];
  for (let index = 0; index < dayCount && index < 367; index++) {
    const dayDate = new Date(firstDate.getTime() + index * DAY_MS);
    const day = dayDate.toISOString().slice(0, 10);
    const from = Math.max(start, dayDate.getTime());
    const to = Math.min(end, dayDate.getTime() + DAY_MS);
    calendar.push({ day, from: new Date(from).toISOString(), to: new Date(to).toISOString(), validLaps: 0,
      positiveLaps: 0, cleanRate: null, drivenSeconds: 0, podiums: 0 });
  }
  return {
    request, revision: 0,
    coverage: { ...coverage, status: coverage.status === "complete" ? "complete" : coverage.status },
    cards, totals, calendar,
    trackDistribution: { totalSeconds: 0, topFive: [], othersSeconds: 0, othersShare: 0, othersCount: 0 },
    favouriteTrack: null, favouriteCar: null,
    consistency: { sessions: 0, averageStandardDeviation: null, deviations: Array(10).fill(0) },
    sessionTypes: { shares: (["practice", "qualifying", "race", "unknown"] as DashboardSessionType[]).map((kind) => ({ kind, seconds: 0, share: 0 })),
      totalSeconds: 0, unknownSeconds: 0, unknownShare: 0, sessionsWithDuration: 0, sessionsWithoutDuration: 0 },
    podiums: { total: 0, first: 0, second: 0, third: 0, available: false },
    recentSessions: [], latestRecapSessionId: null,
  };
}

/**
 * Bounded dashboard read model entry point. One read transaction gives every
 * widget the same source/summary snapshot; aggregates stay in SQLite.
 */
export async function getDashboard(request: DashboardRequest): Promise<DashboardResponse> {
  const bounds = assertRequest(request);
  const database = getDashboardDatabase();
  const tx = {
    execute: <T extends Row = Row>({ sql, args = [] }: { sql: string; args?: (string | number | null)[] }): { rows: T[] } => {
      if (!dashboardQueryObserver) return { rows: database.query<T, (string | number | null)[]>(sql).all(...args) };
      const started = performance.now();
      const rows = database.query<T, (string | number | null)[]>(sql).all(...args);
      dashboardQueryObserver(sql, args, rows, performance.now() - started);
      return { rows };
    },
  };
  return database.transaction(() => {
    const filter = scope(request.gameId, "si");
    const coverageResult = tx.execute({
      sql: `SELECT COUNT(*) AS mine_sessions,MAX(st.source_revision) AS revision,
        SUM(CASE WHEN st.session_id IS NOT NULL AND st.metadata_dirty=0
          AND st.deleted=0 AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision THEN 1 ELSE 0 END) AS ready_sessions,
        SUM(CASE WHEN st.capture_dirty!=0 THEN 1 ELSE 0 END) AS pending_capture
        FROM dashboard_session_index si LEFT JOIN dashboard_summary_state st ON st.session_id=si.session_id
        LEFT JOIN dashboard_session_summaries p ON p.session_id=si.session_id
        WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?${filter.predicate}`,
      args: [bounds.from, bounds.to, ...filter.args],
    });
    const coverageRow = coverageResult.rows[0];
    const mineSessions = n(coverageRow?.mine_sessions), readySessions = n(coverageRow?.ready_sessions);
    const dirtyResult = tx.execute({
      sql: `SELECT candidate.session_id FROM (
          SELECT st.session_id FROM dashboard_summary_state st
          LEFT JOIN dashboard_session_summaries p ON p.session_id=st.session_id
          LEFT JOIN dashboard_session_index si ON si.session_id=st.session_id
          WHERE (st.metadata_dirty!=0 OR st.deleted!=0
            OR COALESCE(st.processor_version,-1)!=${DASHBOARD_PROCESSOR_VERSION}
            OR COALESCE(p.processor_version,-1)!=${DASHBOARD_PROCESSOR_VERSION}
            OR st.published_revision!=st.source_revision OR p.session_id IS NULL
            OR p.source_revision!=st.source_revision)
            AND ((si.created_at_ms>=? AND si.created_at_ms<?${request.gameId ? " AND si.game_id=?" : ""})
              OR EXISTS(SELECT 1 FROM dashboard_session_days old WHERE old.session_id=st.session_id AND old.utc_day>=? AND old.utc_day<?)
              OR EXISTS(SELECT 1 FROM dashboard_lap_index l WHERE l.session_id=st.session_id AND l.created_at_ms>=? AND l.created_at_ms<?))
          UNION
          SELECT si.session_id FROM dashboard_session_index si
          LEFT JOIN dashboard_summary_state st ON st.session_id=si.session_id
          LEFT JOIN dashboard_session_summaries p ON p.session_id=si.session_id
          WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?${request.gameId ? " AND si.game_id=?" : ""}
            AND (st.session_id IS NULL OR p.session_id IS NULL)
        ) candidate ORDER BY candidate.session_id LIMIT ?`,
      args: [
        bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []),
        new Date(bounds.from).toISOString().slice(0, 10), new Date(bounds.to).toISOString().slice(0, 10), bounds.from, bounds.to,
        bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []), MAX_FALLBACK_SESSIONS + 1,
      ],
    });
    const dirtyIds = dirtyResult.rows.map((row) => n(row.session_id));
    const pending = dirtyIds.length > 0 || readySessions < mineSessions
      || n(coverageRow?.pending_capture) > 0;
    const response = emptyDashboard(request, {
      status: pending ? "pending" : "complete", metadataComplete: true,
      mineSessions, readySessions, pendingSessions: mineSessions - readySessions,
    });
    response.revision = n(coverageRow?.revision);
    if (dirtyIds.length > MAX_FALLBACK_SESSIONS) {
      response.coverage.metadataComplete = false;
      return response;
    }

    // Read older complete UTC months, then remaining interior UTC days.
    // Reconcile stale sessions once across both grains and add exact edges.
    const firstFullDayMs = Math.ceil(bounds.from / DAY_MS) * DAY_MS;
    const endFullDayMs = Math.floor(bounds.to / DAY_MS) * DAY_MS;
    const firstFullDay = new Date(firstFullDayMs).toISOString().slice(0, 10);
    const endFullDay = new Date(endFullDayMs).toISOString().slice(0, 10);
    const firstMonthDate = new Date(firstFullDayMs);
    firstMonthDate.setUTCMonth(firstMonthDate.getUTCMonth() + (firstMonthDate.getUTCDate() === 1 ? 0 : 1), 1);
    const recentCutoff = new Date(Math.max(Date.now(), bounds.to) - 30 * DAY_MS);
    recentCutoff.setUTCDate(1);
    recentCutoff.setUTCHours(0, 0, 0, 0);
    const endMonthDate = new Date(endFullDayMs);
    endMonthDate.setUTCDate(1);
    // Historical whole months use monthly grain too, but cannot escape the requested interval.
    endMonthDate.setTime(Math.max(firstMonthDate.getTime(), Math.min(endMonthDate.getTime(), recentCutoff.getTime())));
    const firstMonth = firstMonthDate.toISOString().slice(0, 7);
    const endMonth = endMonthDate.toISOString().slice(0, 7);
    const firstMonthDay = `${firstMonth}-01`;
    const endMonthDay = `${endMonth}-01`;
    const firstDailyEnd = firstMonthDay < endFullDay ? firstMonthDay : endFullDay;
    const lastDailyStart = endMonthDay > firstFullDay ? endMonthDay : firstFullDay;
    const dirtyBindings = dirtyIds.slice(0, MAX_FALLBACK_SESSIONS);
    const dirtyIn = dirtyBindings.length ? dirtyBindings.map(() => "?").join(",") : "NULL";
    const dirtyCte = dirtyBindings.length ? `VALUES ${dirtyBindings.map(() => "(?)").join(",")}` : "SELECT NULL WHERE 0";
    const needsDaySource = dirtyBindings.length > 0 || bounds.from !== firstFullDayMs || bounds.to !== endFullDayMs;
    const entityResult = tx.execute({
      sql: `WITH dirty(session_id) AS (${dirtyCte}),
        daily_entities AS (
          SELECT * FROM dashboard_day_entities WHERE utc_day>=? AND utc_day<?
          UNION ALL
          SELECT * FROM dashboard_day_entities WHERE utc_day>=? AND utc_day<?
        ),
        day_rollup AS (
          SELECT m.utc_month||'-01' utc_day,m.game_id,m.car_key,m.track_key,m.lap_count,m.positive_laps,m.valid_laps,
            m.driven_seconds,m.valid_seconds,m.favourite_laps,m.favourite_seconds,m.distance_laps,m.distance_meters,
            m.podium_first,m.podium_second,m.podium_third,0 podium_evidence
          FROM dashboard_month_entities m WHERE m.utc_month>=? AND m.utc_month<?
          UNION ALL
          SELECT d.utc_day,d.game_id,d.car_key,d.track_key,d.lap_count,d.positive_laps,d.valid_laps,
            d.driven_seconds,d.valid_seconds,d.favourite_laps,d.favourite_seconds,d.distance_laps,d.distance_meters,
            d.podium_first,d.podium_second,d.podium_third,0 podium_evidence
          FROM daily_entities d
          UNION ALL
          SELECT old.utc_day,old.game_id,old.car_key,old.track_key,-old.lap_count,-old.positive_laps,-old.valid_laps,
            -old.driven_seconds,-old.valid_seconds,-old.favourite_laps,-old.favourite_seconds,-old.distance_laps,
            -COALESCE(old.distance_meters,0),-old.podium_first,-old.podium_second,-old.podium_third,0 podium_evidence
          FROM dashboard_session_days old JOIN dirty x ON x.session_id=old.session_id
          WHERE old.utc_day>=? AND old.utc_day<?
        ), current_source AS (
          SELECT date(l.created_at_ms/1000,'unixepoch') utc_day,si.game_id,
            COALESCE(NULLIF(si.car_id,''),'#ord:'||si.car_ordinal) car_key,
            COALESCE(NULLIF(si.track_id,''),'#ord:'||si.track_ordinal) track_key,
            COUNT(*) lap_count,SUM(l.lap_time>0) positive_laps,SUM(l.is_valid=1 AND l.lap_time>0) valid_laps,
            SUM(CASE WHEN l.lap_time>0 THEN l.lap_time ELSE 0 END) driven_seconds,
            SUM(CASE WHEN l.is_valid=1 AND l.lap_time>0 THEN l.lap_time ELSE 0 END) valid_seconds,
            SUM(l.lap_time>0 AND COALESCE(l.invalid_reason,'')!='incomplete') favourite_laps,
            SUM(CASE WHEN l.lap_time>0 AND COALESCE(l.invalid_reason,'')!='incomplete' THEN l.lap_time ELSE 0 END) favourite_seconds,
            SUM(l.lap_time>0 AND COALESCE(l.invalid_reason,'')!='incomplete' AND p.track_length_meters>0
              AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0
              AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
              AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision) distance_laps,
            SUM(CASE WHEN l.lap_time>0 AND COALESCE(l.invalid_reason,'')!='incomplete'
              AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0
              AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
              AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision
              THEN COALESCE(p.track_length_meters,0) ELSE 0 END) distance_meters,
            0 podium_first,0 podium_second,0 podium_third,0 podium_evidence
          FROM dashboard_lap_index l JOIN dashboard_session_index si ON si.session_id=l.session_id
          LEFT JOIN dashboard_session_summaries p ON p.session_id=si.session_id
          LEFT JOIN dashboard_summary_state st ON st.session_id=si.session_id
          WHERE ${needsDaySource ? "" : "0 AND "}si.ownership='mine' AND l.created_at_ms>=? AND l.created_at_ms<?
            AND (l.created_at_ms<? OR l.created_at_ms>=? OR l.session_id IN (${dirtyIn}))
          GROUP BY utc_day,si.game_id,track_key,car_key
        ), current_results AS (
          SELECT date(si.created_at_ms/1000,'unixepoch') utc_day,si.game_id,
            COALESCE(NULLIF(si.car_id,''),'#ord:'||si.car_ordinal) car_key,
            COALESCE(NULLIF(si.track_id,''),'#ord:'||si.track_ordinal) track_key,
            0 lap_count,0 positive_laps,0 valid_laps,0 driven_seconds,0 valid_seconds,
            0 favourite_laps,0 favourite_seconds,0 distance_laps,0 distance_meters,
            SUM(r.finishing_position=1) podium_first,SUM(r.finishing_position=2) podium_second,SUM(r.finishing_position=3) podium_third,0 podium_evidence
          FROM session_results r JOIN dashboard_session_index si ON si.session_id=r.session_id
          WHERE ${needsDaySource ? "" : "0 AND "}si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
            AND (si.session_id IN (${dirtyIn}) OR si.created_at_ms<? OR si.created_at_ms>=?)
            AND lower(trim(si.session_type)) LIKE 'race%' AND r.outcome_status='confirmed' AND r.classification='finished'
            AND r.finishing_position>0 AND r.finishing_position=CAST(r.finishing_position AS INTEGER)
          GROUP BY si.session_id
        ), result_evidence AS (
          SELECT date(si.created_at_ms/1000,'unixepoch') utc_day,si.game_id,p.car_key,p.track_key,
            0 lap_count,0 positive_laps,0 valid_laps,0 driven_seconds,0 valid_seconds,
            0 favourite_laps,0 favourite_seconds,0 distance_laps,0 distance_meters,
            0 podium_first,0 podium_second,0 podium_third,COUNT(DISTINCT si.session_id) podium_evidence
          FROM session_results r JOIN dashboard_session_index si ON si.session_id=r.session_id
          JOIN dashboard_session_summaries p ON p.session_id=si.session_id
          JOIN dashboard_summary_state st ON st.session_id=si.session_id
          WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
            AND st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0
            AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
            AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision
            AND lower(trim(si.session_type)) LIKE 'race%' AND r.outcome_status='confirmed' AND r.classification='finished'
            AND r.finishing_position>0 AND r.finishing_position=CAST(r.finishing_position AS INTEGER)${request.gameId ? " AND si.game_id=?" : ""}
          GROUP BY utc_day,si.game_id,p.car_key,p.track_key
        )
        SELECT f.game_id,f.car_key,f.track_key,SUM(f.lap_count) lap_count,SUM(f.positive_laps) positive_laps,
          SUM(f.valid_laps) valid_laps,SUM(f.driven_seconds) driven_seconds,SUM(f.valid_seconds) valid_seconds,
          SUM(f.favourite_laps) favourite_laps,SUM(f.favourite_seconds) favourite_seconds,
          SUM(f.distance_laps) distance_laps,SUM(f.distance_meters) distance_meters,
          SUM(f.podium_first) podium_first,SUM(f.podium_second) podium_second,SUM(f.podium_third) podium_third,
          MAX(f.podium_evidence) podium_evidence
        FROM (SELECT * FROM day_rollup UNION ALL SELECT * FROM current_source UNION ALL SELECT * FROM current_results
          UNION ALL SELECT * FROM result_evidence) f
        GROUP BY f.game_id,f.car_key,f.track_key`,
      args: [
        ...dirtyBindings,
        firstFullDay, firstDailyEnd, lastDailyStart, endFullDay,
        firstMonth, endMonth,
        firstFullDay, endFullDay,
        bounds.from, bounds.to, firstFullDayMs, endFullDayMs, ...dirtyBindings,
        ...dirtyBindings, bounds.from, bounds.to, firstFullDayMs, endFullDayMs,
        bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []),
      ],
    });
    type EntityFacts = { gameId: GameId; identity: string; nativeId: number | string | null; ordinal: number | null;
      seconds: number; laps: number; sessions: number; distanceMeters: number; distanceLaps: number; podiums: number; podiumEvidence: boolean };
    const decodeIdentity = (value: string, gameId: GameId, kind: "car" | "track") => {
      if (value.startsWith("[")) {
        try {
          const parsed = JSON.parse(value) as [string, string];
          const key = parsed[1] ?? "";
          const match = /^n:(-?\d+(?:\.\d+)?)$/.exec(key);
          return { identity: JSON.stringify([gameId, key]), nativeId: match ? Number(match[1]) : key.slice(2), ordinal: match ? Number(match[1]) : null };
        } catch { return { identity: value, nativeId: null, ordinal: null }; }
      }
      if (value.startsWith("#ord:")) {
        const rawOrdinal = value.slice(5);
        const ordinal = Number(rawOrdinal);
        if (!rawOrdinal || !Number.isInteger(ordinal) || !Number.isFinite(ordinal) || ordinal === -1) {
          return { identity: "", nativeId: null, ordinal: null };
        }
        const identity = kind === "car" ? dashboardCarIdentity(gameId, null, ordinal) : dashboardTrackIdentity(gameId, null, ordinal);
        return identity ? { identity, nativeId: ordinal, ordinal } : { identity: "", nativeId: null, ordinal: null };
      }
      const native = value === "" ? null : value;
      const identity = kind === "car" ? dashboardCarIdentity(gameId, native, null) : dashboardTrackIdentity(gameId, native, null);
      const numeric = native != null && Number.isFinite(Number(native)) && String(Number(native)) === native;
      return { identity: identity ?? "", nativeId: numeric ? Number(native) : native, ordinal: numeric ? Number(native) : null };
    };
    const tracks = new Map<string, EntityFacts>(), cars = new Map<string, EntityFacts>();
    const favouriteTracks = new Map<string, EntityFacts>(), favouriteCars = new Map<string, EntityFacts>();
    for (const raw of entityResult.rows) {
      const row = raw as Row, gameId = String(row.game_id) as GameId;
      if (!KNOWN_GAME_IDS.includes(gameId)) continue;
      const track = decodeIdentity(String(row.track_key ?? ""), gameId, "track");
      const car = decodeIdentity(String(row.car_key ?? ""), gameId, "car");
      const values = {
        seconds: n(row.driven_seconds), laps: n(row.positive_laps), distanceMeters: n(row.distance_meters),
        distanceLaps: n(row.distance_laps), podiums: n(row.podium_first) + n(row.podium_second) + n(row.podium_third), podiumEvidence: n(row.podium_evidence) > 0,
      };
      const favouriteValues = { ...values, seconds: n(row.favourite_seconds), laps: n(row.favourite_laps) };
      const add = (map: Map<string, EntityFacts>, ident: typeof track, facts: typeof values) => {
        if (!ident.identity) return;
        const current = map.get(ident.identity) ?? { gameId, identity: ident.identity, nativeId: ident.nativeId, ordinal: ident.ordinal,
          seconds: 0, laps: 0, sessions: 0, distanceMeters: 0, distanceLaps: 0, podiums: 0, podiumEvidence: false };
        current.seconds += facts.seconds;
        current.laps += facts.laps;
        current.distanceMeters += facts.distanceMeters;
        current.distanceLaps += facts.distanceLaps;
        current.podiums += facts.podiums; current.podiumEvidence ||= facts.podiumEvidence;
        map.set(ident.identity, current);
      };
      if (!request.gameId || request.gameId === gameId) {
        add(tracks, track, values); add(cars, car, values);
        add(favouriteTracks, track, favouriteValues); add(favouriteCars, car, favouriteValues);
      }
      const card = response.cards[gameId]!;
      card.laps += n(row.lap_count);
      card.drivenSeconds += n(row.driven_seconds);
    }
    const periodFacts = tx.execute({
      sql: `WITH dirty(session_id) AS (
          SELECT st.session_id FROM dashboard_summary_state st
          LEFT JOIN dashboard_session_summaries p ON p.session_id=st.session_id
          WHERE st.metadata_dirty!=0 OR st.deleted!=0
            OR COALESCE(st.processor_version,-1)!=${DASHBOARD_PROCESSOR_VERSION}
            OR COALESCE(p.processor_version,-1)!=${DASHBOARD_PROCESSOR_VERSION}
            OR st.published_revision!=st.source_revision OR p.session_id IS NULL
            OR p.source_revision!=st.source_revision),
        sessions_in_period AS (
          SELECT DISTINCT d.session_id FROM dashboard_session_days d
          WHERE d.utc_day>=? AND d.utc_day<?${request.gameId ? " AND d.game_id=?" : ""}
            AND NOT EXISTS(SELECT 1 FROM dirty x WHERE x.session_id=d.session_id)
          UNION
          SELECT DISTINCT l.session_id FROM dashboard_lap_index l JOIN dashboard_session_index si ON si.session_id=l.session_id
          WHERE ${needsDaySource ? "" : "0 AND "}si.ownership='mine' AND l.created_at_ms>=? AND l.created_at_ms<?
            AND (l.created_at_ms<? OR l.created_at_ms>=? OR l.session_id IN (${dirtyIn}))${request.gameId ? " AND si.game_id=?" : ""}
        ), best_values(best) AS (
          SELECT p.best_lap_seconds FROM dashboard_session_summaries p
          JOIN dashboard_session_index si ON si.session_id=p.session_id
          JOIN dashboard_summary_state st ON st.session_id=p.session_id
          WHERE si.ownership='mine' AND p.best_lap_seconds>0 AND p.valid_laps>0
            AND p.first_lap_at_ms>=? AND p.last_lap_at_ms<?
            AND st.metadata_dirty=0 AND st.deleted=0
            AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
            AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision${request.gameId ? " AND si.game_id=?" : ""}
          UNION ALL
          SELECT MIN(l.lap_time) FROM dashboard_lap_index l
          JOIN dashboard_session_index si ON si.session_id=l.session_id
          LEFT JOIN dashboard_session_summaries p ON p.session_id=si.session_id
          WHERE si.ownership='mine' AND l.created_at_ms>=? AND l.created_at_ms<?
            AND l.is_valid=1 AND l.lap_time>0
            AND (l.session_id IN (${dirtyIn}) OR p.session_id IS NULL
              OR COALESCE(p.processor_version,-1)!=${DASHBOARD_PROCESSOR_VERSION}
              OR p.first_lap_at_ms<? OR p.last_lap_at_ms>=?)${request.gameId ? " AND si.game_id=?" : ""}
          GROUP BY l.session_id
        )
        SELECT (SELECT COUNT(*) FROM sessions_in_period) sessions,(SELECT MIN(best) FROM best_values) best_lap_seconds`,
      args: [
        firstFullDay, endFullDay, ...(request.gameId ? [request.gameId] : []),
        bounds.from, bounds.to, firstFullDayMs, endFullDayMs, ...dirtyBindings, ...(request.gameId ? [request.gameId] : []),
        bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []),
        bounds.from, bounds.to, ...dirtyBindings, bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []),
      ],
    });
    const periodRow = periodFacts.rows[0] as Row | undefined;
    response.totals.sessions = n(periodRow?.sessions);
    response.totals.bestLapSeconds = nullableNumber(periodRow?.best_lap_seconds);
    const selectedRows = entityResult.rows.filter((raw) => !request.gameId || String((raw as Row).game_id) === request.gameId);
    const selectedTracks = new Map<string, number>(), selectedCars = new Map<string, number>();
    for (const raw of selectedRows) {
      const row = raw as Row, gameId = String(row.game_id) as GameId, lapCount = n(row.lap_count);
      const track = decodeIdentity(String(row.track_key ?? ""), gameId, "track");
      const car = decodeIdentity(String(row.car_key ?? ""), gameId, "car");
      if (track.identity) selectedTracks.set(track.identity, (selectedTracks.get(track.identity) ?? 0) + lapCount);
      if (car.identity) selectedCars.set(car.identity, (selectedCars.get(car.identity) ?? 0) + lapCount);
    }
    response.totals = {
      laps: selectedRows.reduce((sum, raw) => sum + n((raw as Row).lap_count), 0),
      positiveLaps: selectedRows.reduce((sum, raw) => sum + n((raw as Row).positive_laps), 0),
      validLaps: selectedRows.reduce((sum, raw) => sum + n((raw as Row).valid_laps), 0),
      drivenSeconds: selectedRows.reduce((sum, raw) => sum + n((raw as Row).driven_seconds), 0),
      validSeconds: selectedRows.reduce((sum, raw) => sum + n((raw as Row).valid_seconds), 0),
      bestLapSeconds: nullableNumber(periodRow?.best_lap_seconds), averageLapSeconds: null,
      tracks: [...selectedTracks.values()].filter((laps) => laps > 0).length,
      cars: [...selectedCars.values()].filter((laps) => laps > 0).length, sessions: n(periodRow?.sessions),
    };
    response.totals.averageLapSeconds = response.totals.validLaps ? response.totals.validSeconds / response.totals.validLaps : null;
    const rankedTracks = [...tracks.values()].sort((a, b) => b.seconds - a.seconds || a.gameId.localeCompare(b.gameId) || a.identity.localeCompare(b.identity));
    const totalTrackSeconds = rankedTracks.reduce((sum, entity) => sum + entity.seconds, 0);
    const otherTrackSeconds = rankedTracks.slice(5).reduce((sum, entity) => sum + entity.seconds, 0);
    response.trackDistribution = {
      totalSeconds: totalTrackSeconds,
      topFive: rankedTracks.slice(0, 5).map((entity): DashboardEntityTotal => ({
        gameId: entity.gameId, identity: entity.identity, ordinal: entity.ordinal,
        seconds: entity.seconds, share: totalTrackSeconds ? entity.seconds / totalTrackSeconds : 0,
      })),
      othersSeconds: otherTrackSeconds, othersShare: totalTrackSeconds ? otherTrackSeconds / totalTrackSeconds : 0,
      othersCount: Math.max(0, rankedTracks.length - 5),
    };
    const members = tx.execute({
      sql: `WITH dirty(session_id) AS (${dirtyCte}), member_rows(kind,game_id,identity_key,session_id) AS (
        SELECT 'track',d.game_id,d.track_key,d.session_id FROM dashboard_session_days d
        WHERE d.utc_day>=? AND d.utc_day<? AND d.track_key!='' AND NOT EXISTS(SELECT 1 FROM dirty x WHERE x.session_id=d.session_id)
        UNION
        SELECT 'car',d.game_id,d.car_key,d.session_id FROM dashboard_session_days d
        WHERE d.utc_day>=? AND d.utc_day<? AND d.car_key!='' AND NOT EXISTS(SELECT 1 FROM dirty x WHERE x.session_id=d.session_id)
        UNION
        SELECT 'track',si.game_id,
          CASE WHEN p.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dirty x WHERE x.session_id=si.session_id)
            THEN p.track_key ELSE COALESCE(NULLIF(si.track_id,''),'#ord:'||si.track_ordinal) END,l.session_id
        FROM dashboard_lap_index l JOIN dashboard_session_index si ON si.session_id=l.session_id
        LEFT JOIN dashboard_session_summaries p ON p.session_id=si.session_id
        WHERE ${needsDaySource ? "" : "0 AND "}si.ownership='mine' AND l.created_at_ms>=? AND l.created_at_ms<?
          AND (l.session_id IN (${dirtyIn}) OR l.created_at_ms<? OR l.created_at_ms>=?)
        UNION
        SELECT 'car',si.game_id,
          CASE WHEN p.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dirty x WHERE x.session_id=si.session_id)
            THEN p.car_key ELSE COALESCE(NULLIF(si.car_id,''),'#ord:'||si.car_ordinal) END,l.session_id
        FROM dashboard_lap_index l JOIN dashboard_session_index si ON si.session_id=l.session_id
        LEFT JOIN dashboard_session_summaries p ON p.session_id=si.session_id
        WHERE ${needsDaySource ? "" : "0 AND "}si.ownership='mine' AND l.created_at_ms>=? AND l.created_at_ms<?
          AND (l.session_id IN (${dirtyIn}) OR l.created_at_ms<? OR l.created_at_ms>=?)
        UNION
        SELECT 'track',p.game_id,p.track_key,p.session_id FROM dashboard_session_summaries p
        JOIN dashboard_session_index si ON si.session_id=p.session_id JOIN dashboard_summary_state st ON st.session_id=p.session_id
          AND si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<? AND p.track_key!=''
          AND st.metadata_dirty=0 AND st.deleted=0
          AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision
        UNION
        SELECT 'car',p.game_id,p.car_key,p.session_id FROM dashboard_session_summaries p
        JOIN dashboard_session_index si ON si.session_id=p.session_id JOIN dashboard_summary_state st ON st.session_id=p.session_id
        WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<? AND p.car_key!=''
          AND st.metadata_dirty=0 AND st.deleted=0
          AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision
        UNION
        SELECT 'track',si.game_id,COALESCE(NULLIF(si.track_id,''),'#ord:'||si.track_ordinal),si.session_id
        FROM dashboard_session_index si WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
          AND si.session_id IN (${dirtyIn})
        UNION
        SELECT 'car',si.game_id,COALESCE(NULLIF(si.car_id,''),'#ord:'||si.car_ordinal),si.session_id
        FROM dashboard_session_index si WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
          AND si.session_id IN (${dirtyIn})
      )
      SELECT kind,game_id,identity_key,COUNT(DISTINCT session_id) sessions FROM member_rows GROUP BY kind,game_id,identity_key`,
      args: [
        ...dirtyBindings,
        firstFullDay, endFullDay, firstFullDay, endFullDay,
        bounds.from, bounds.to, ...dirtyBindings, firstFullDayMs, endFullDayMs,
        bounds.from, bounds.to, ...dirtyBindings, firstFullDayMs, endFullDayMs,
        bounds.from, bounds.to, // clean published track sessions
        bounds.from, bounds.to, // clean published car sessions
        bounds.from, bounds.to, ...dirtyBindings, // dirty track sessions
        bounds.from, bounds.to, ...dirtyBindings, // dirty car sessions
      ],
    });
    // Clean boundary/interior rows share published keys; raw dirty groups have disjoint session IDs.
    for (const raw of members.rows) {
      const row = raw as Row, gameId = String(row.game_id) as GameId;
      const kind = String(row.kind);
      const identity = decodeIdentity(String(row.identity_key ?? ""), gameId, kind === "car" ? "car" : "track").identity;
      if (kind === "track") {
        const track = favouriteTracks.get(identity);
        if (track) track.sessions += n(row.sessions);
      } else {
        const car = favouriteCars.get(identity);
        if (car) car.sessions += n(row.sessions);
      }
    }
    const chooseFavourite = (map: Map<string, EntityFacts>): DashboardFavourite | null => {
      const winner = [...map.values()].sort((a, b) => b.seconds - a.seconds || b.laps - a.laps
        || a.gameId.localeCompare(b.gameId) || a.identity.localeCompare(b.identity))[0];
      return winner ? { gameId: winner.gameId, identity: winner.identity, nativeId: winner.nativeId, ordinal: winner.ordinal,
        seconds: winner.seconds, laps: winner.laps, sessions: winner.sessions,
        distanceMeters: winner.distanceLaps ? winner.distanceMeters : null, distanceLaps: winner.distanceLaps,
        podiums: pending || !winner.podiumEvidence ? null : winner.podiums } : null;
    };
    response.favouriteTrack = chooseFavourite(favouriteTracks);
    response.favouriteCar = chooseFavourite(favouriteCars);
    const firstFullBucket = Math.ceil(bounds.from / BUCKET_MS) * BUCKET_MS;
    const endFullBucket = Math.floor(bounds.to / BUCKET_MS) * BUCKET_MS;
    const needsBucketSource = dirtyBindings.length > 0 || bounds.from !== firstFullBucket || bounds.to !== endFullBucket;
    const timeBuckets = tx.execute({
      sql: `WITH dirty(session_id) AS (${dirtyCte}), facts AS (
        SELECT b.bucket_start_ms,b.game_id,b.valid_laps,b.positive_laps,b.driven_seconds,b.podium_first,b.podium_second,b.podium_third
        FROM dashboard_time_buckets b WHERE b.bucket_start_ms>=? AND b.bucket_start_ms+?<=?
        UNION ALL
        SELECT old.bucket_start_ms,old.game_id,-old.valid_laps,-old.positive_laps,-old.driven_seconds,-old.podium_first,-old.podium_second,-old.podium_third
        FROM dashboard_session_time_buckets old JOIN dirty d ON d.session_id=old.session_id
        WHERE old.bucket_start_ms>=? AND old.bucket_start_ms+?<=?
        UNION ALL
        SELECT CAST(l.created_at_ms/? AS INTEGER)*?,si.game_id,SUM(l.is_valid=1 AND l.lap_time>0),SUM(l.lap_time>0),
          SUM(CASE WHEN l.lap_time>0 THEN l.lap_time ELSE 0 END),0,0,0
        FROM dashboard_lap_index l JOIN dashboard_session_index si ON si.session_id=l.session_id
        WHERE ${needsBucketSource ? "" : "0 AND "}si.ownership='mine' AND l.created_at_ms>=? AND l.created_at_ms<?
          AND (l.session_id IN (${dirtyIn}) OR l.created_at_ms<? OR l.created_at_ms>=?)
        GROUP BY CAST(l.created_at_ms/? AS INTEGER)*?,si.game_id
      ), current_results AS (
        SELECT CAST(si.created_at_ms/? AS INTEGER)*?,si.game_id,0,0,0,
          SUM(r.finishing_position=1),SUM(r.finishing_position=2),SUM(r.finishing_position=3)
        FROM session_results r JOIN dashboard_session_index si ON si.session_id=r.session_id
        WHERE ${needsBucketSource ? "" : "0 AND "}si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
          AND (si.session_id IN (${dirtyIn}) OR si.created_at_ms<? OR si.created_at_ms>=?)
          AND lower(trim(si.session_type)) LIKE 'race%' AND r.outcome_status='confirmed' AND r.classification='finished'
          AND r.finishing_position>0 AND r.finishing_position=CAST(r.finishing_position AS INTEGER)
        GROUP BY CAST(si.created_at_ms/? AS INTEGER)*?,si.game_id
      )
      SELECT bucket_start_ms,game_id,SUM(valid_laps) valid_laps,SUM(positive_laps) positive_laps,
        SUM(driven_seconds) driven_seconds,SUM(podium_first) podium_first,SUM(podium_second) podium_second,
        SUM(podium_third) podium_third FROM (SELECT * FROM facts UNION ALL SELECT * FROM current_results)
        GROUP BY bucket_start_ms,game_id ORDER BY bucket_start_ms,game_id`,
      args: [
        ...dirtyBindings,
        firstFullBucket, BUCKET_MS, endFullBucket,
        firstFullBucket, BUCKET_MS, endFullBucket,
        BUCKET_MS, BUCKET_MS, bounds.from, bounds.to, ...dirtyBindings, firstFullBucket, endFullBucket,
        BUCKET_MS, BUCKET_MS,
        BUCKET_MS, BUCKET_MS, bounds.from, bounds.to, ...dirtyBindings, firstFullBucket, endFullBucket,
        BUCKET_MS, BUCKET_MS,
      ],
    });
    const heat = new Map<string, { validLaps: number; positiveLaps: number; drivenSeconds: number; podiums: number }>();
    for (const raw of timeBuckets.rows) {
      const row = raw as Row;
      if (request.gameId && String(row.game_id) !== request.gameId) continue;
      const day = new Date(n(row.bucket_start_ms)).toISOString().slice(0, 10);
      const aggregate = heat.get(day) ?? { validLaps: 0, positiveLaps: 0, drivenSeconds: 0, podiums: 0 };
      aggregate.validLaps += n(row.valid_laps); aggregate.positiveLaps += n(row.positive_laps);
      aggregate.drivenSeconds += n(row.driven_seconds);
      aggregate.podiums += n(row.podium_first) + n(row.podium_second) + n(row.podium_third);
      heat.set(day, aggregate);
    }
    response.calendar = response.calendar.map((bucket) => {
      const values = heat.get(bucket.day);
      return values ? { ...bucket, ...values, cleanRate: values.positiveLaps ? values.validLaps / values.positiveLaps : null } : bucket;
    });
    const consistencyResult = tx.execute({
      sql: `WITH RECURSIVE moments(session_id,n,mean,m2) AS (
        SELECT p.session_id,p.valid_laps,p.valid_mean_seconds,p.valid_m2_seconds
        FROM dashboard_session_summaries p JOIN dashboard_session_index si ON si.session_id=p.session_id
        JOIN dashboard_summary_state st ON st.session_id=p.session_id
        WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
          AND p.first_lap_at_ms>=? AND p.last_lap_at_ms<?
          AND p.valid_laps>=2 AND p.valid_mean_seconds IS NOT NULL AND p.valid_m2_seconds IS NOT NULL
          AND p.car_key IS NOT NULL AND p.car_key!='' AND p.track_key IS NOT NULL AND p.track_key!=''
          AND st.metadata_dirty=0 AND st.deleted=0
          AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision${request.gameId ? " AND si.game_id=?" : ""}
        UNION ALL
        SELECT l.session_id,COUNT(*),AVG(l.lap_time),SUM((l.lap_time-avg_time.mean)*(l.lap_time-avg_time.mean))
        FROM dashboard_lap_index l JOIN dashboard_session_index si ON si.session_id=l.session_id
        LEFT JOIN dashboard_session_summaries p ON p.session_id=l.session_id
        JOIN (SELECT l.session_id,AVG(l.lap_time) mean FROM dashboard_lap_index l
          LEFT JOIN dashboard_session_summaries p ON p.session_id=l.session_id
          WHERE l.created_at_ms>=? AND l.created_at_ms<? AND l.is_valid=1 AND l.lap_time>0
            AND (l.session_id IN (${dirtyIn}) OR p.session_id IS NULL
              OR COALESCE(p.processor_version,-1)!=${DASHBOARD_PROCESSOR_VERSION}
              OR p.first_lap_at_ms<? OR p.last_lap_at_ms>=?)
          GROUP BY l.session_id) avg_time ON avg_time.session_id=l.session_id
        WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
          AND l.created_at_ms>=? AND l.created_at_ms<? AND l.is_valid=1 AND l.lap_time>0
          AND (l.session_id IN (${dirtyIn}) OR p.session_id IS NULL
            OR COALESCE(p.processor_version,-1)!=${DASHBOARD_PROCESSOR_VERSION}
            OR p.first_lap_at_ms<? OR p.last_lap_at_ms>=?)
          AND si.car_ordinal!=-1 AND si.track_ordinal!=-1
          ${request.gameId ? "AND si.game_id=?" : ""}
        GROUP BY l.session_id
      ), eligible AS (
        SELECT session_id,n,mean,m2/n variance FROM moments WHERE n>=2 AND n>0 AND mean IS NOT NULL AND m2 IS NOT NULL
      ), deviations AS (
        SELECT sqrt(MAX(variance,0)) sd FROM eligible
      )
      SELECT COUNT(*) sessions,AVG(sd) average_sd,
        SUM(CASE WHEN sd<0.1 THEN 1 ELSE 0 END) b0,SUM(CASE WHEN sd>=0.1 AND sd<0.2 THEN 1 ELSE 0 END) b1,
        SUM(CASE WHEN sd>=0.2 AND sd<0.3 THEN 1 ELSE 0 END) b2,SUM(CASE WHEN sd>=0.3 AND sd<0.4 THEN 1 ELSE 0 END) b3,
        SUM(CASE WHEN sd>=0.4 AND sd<0.5 THEN 1 ELSE 0 END) b4,SUM(CASE WHEN sd>=0.5 AND sd<0.6 THEN 1 ELSE 0 END) b5,
        SUM(CASE WHEN sd>=0.6 AND sd<0.7 THEN 1 ELSE 0 END) b6,SUM(CASE WHEN sd>=0.7 AND sd<0.8 THEN 1 ELSE 0 END) b7,
        SUM(CASE WHEN sd>=0.8 AND sd<0.9 THEN 1 ELSE 0 END) b8,SUM(CASE WHEN sd>=0.9 THEN 1 ELSE 0 END) b9
      FROM deviations`,
      args: [
        bounds.from, bounds.to, bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []),
        bounds.from, bounds.to, ...dirtyBindings, bounds.from, bounds.to, bounds.from, bounds.to,
        bounds.from, bounds.to, ...dirtyBindings, bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []),
      ],
    });
    const consistency = consistencyResult.rows[0] as Row | undefined;
    response.consistency = {
      sessions: n(consistency?.sessions), averageStandardDeviation: nullableNumber(consistency?.average_sd),
      deviations: Array.from({ length: 10 }, (_, index) => n(consistency?.[`b${index}`])),
    };
    const recentResult = tx.execute({
      sql: `SELECT si.session_id,si.game_id,si.created_at_ms,si.session_type,si.car_id,si.car_ordinal,si.track_id,si.track_ordinal,
        CASE WHEN st.metadata_dirty=0 AND st.deleted=0
          AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision THEN p.lap_count
          ELSE (SELECT COUNT(*) FROM dashboard_lap_index l WHERE l.session_id=si.session_id) END lap_count,
        CASE WHEN st.metadata_dirty=0 AND st.deleted=0
          AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision THEN p.best_lap_seconds
          ELSE (SELECT MIN(l.lap_time) FROM dashboard_lap_index l WHERE l.session_id=si.session_id
            AND l.is_valid=1 AND l.lap_time>0) END best_lap_seconds
        FROM dashboard_session_index si
        LEFT JOIN dashboard_summary_state st ON st.session_id=si.session_id
        LEFT JOIN dashboard_session_summaries p ON p.session_id=si.session_id
        WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?${request.gameId ? " AND si.game_id=?" : ""}
        ORDER BY si.created_at_ms DESC,si.session_id DESC LIMIT 10`,
      args: [bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : [])],
    });
    response.recentSessions = recentResult.rows.map((raw) => {
      const row = raw as Row, gameId = String(row.game_id) as GameId;
      const carOrdinal = nullableNumber(row.car_ordinal), trackOrdinal = nullableNumber(row.track_ordinal);
      return {
        id: n(row.session_id), gameId, createdAt: new Date(n(row.created_at_ms)).toISOString(),
        sessionType: row.session_type == null ? null : String(row.session_type),
        car: { id: row.car_id == null ? null : row.car_id as string, ordinal: carOrdinal, name: null },
        track: { id: row.track_id == null ? null : row.track_id as string, ordinal: trackOrdinal, name: null },
        lapCount: n(row.lap_count), bestLapSeconds: nullableNumber(row.best_lap_seconds),
      };
    });
    response.latestRecapSessionId = response.recentSessions[0]?.id ?? null;
    const sessionStats = tx.execute({
      sql: `SELECT
          SUM(CASE WHEN duration_status='available' AND elapsed_seconds>=0 THEN elapsed_seconds ELSE 0 END) duration_seconds,
          SUM(CASE WHEN duration_status='available' AND elapsed_seconds>=0 THEN 1 ELSE 0 END) with_duration,
          COUNT(*) sessions_in_scope,
          EXISTS (SELECT 1 FROM session_results r JOIN dashboard_session_index result_si ON result_si.session_id=r.session_id
            WHERE result_si.ownership='mine' AND result_si.created_at_ms>=? AND result_si.created_at_ms<?
              AND lower(trim(result_si.session_type)) LIKE 'race%' AND r.outcome_status='confirmed' AND r.classification='finished'
              AND r.finishing_position>0 AND r.finishing_position=CAST(r.finishing_position AS INTEGER)${request.gameId ? " AND result_si.game_id=?" : ""}) podium_evidence,
          SUM(CASE WHEN podium_status='confirmed' AND podium_position=1 THEN 1 ELSE 0 END) firsts,
          SUM(CASE WHEN podium_status='confirmed' AND podium_position=2 THEN 1 ELSE 0 END) seconds,
          SUM(CASE WHEN podium_status='confirmed' AND podium_position=3 THEN 1 ELSE 0 END) thirds
        FROM dashboard_session_summaries p JOIN dashboard_session_index si ON si.session_id=p.session_id
        JOIN dashboard_summary_state st ON st.session_id=p.session_id
        WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<?
          AND st.metadata_dirty=0 AND st.deleted=0
          AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision${request.gameId ? " AND si.game_id=?" : ""}`,
      args: [bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : []), bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : [])],
    });
    const stats = sessionStats.rows[0] as Row | undefined;
    const durationSeconds = n(stats?.duration_seconds);
    const withDuration = n(stats?.with_duration);
    const classified: Record<DashboardSessionType, number> = { practice: 0, qualifying: 0, race: 0, unknown: 0 };
    const durationRows = tx.execute({
      sql: `SELECT CASE WHEN lower(trim(COALESCE(p.session_type,'')))='test-day' OR lower(trim(COALESCE(p.session_type,''))) LIKE 'practice%' THEN 'practice'
          WHEN lower(trim(COALESCE(p.session_type,''))) LIKE 'qualifying%' OR lower(trim(COALESCE(p.session_type,''))) LIKE 'qualify%' THEN 'qualifying'
          WHEN lower(trim(COALESCE(p.session_type,''))) LIKE 'race%' THEN 'race' ELSE 'unknown' END kind,
        SUM(p.elapsed_seconds) seconds
        FROM dashboard_session_summaries p JOIN dashboard_session_index si ON si.session_id=p.session_id
        JOIN dashboard_summary_state st ON st.session_id=p.session_id
        WHERE si.ownership='mine' AND si.created_at_ms>=? AND si.created_at_ms<? AND p.duration_status='available' AND p.elapsed_seconds>=0
          AND st.metadata_dirty=0 AND st.deleted=0
          AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
          AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision${request.gameId ? " AND si.game_id=?" : ""}
        GROUP BY kind`,
      args: [bounds.from, bounds.to, ...(request.gameId ? [request.gameId] : [])],
    });
    for (const raw of durationRows.rows) {
      const row = raw as Row, kind = String(row.kind) as DashboardSessionType;
      classified[kind] += n(row.seconds);
    }
    response.sessionTypes = {
      shares: (Object.entries(classified) as [DashboardSessionType, number][]).map(([kind, seconds]) => ({ kind, seconds, share: durationSeconds ? seconds / durationSeconds : 0 })),
      totalSeconds: durationSeconds, unknownSeconds: classified.unknown, unknownShare: durationSeconds ? classified.unknown / durationSeconds : 0,
      sessionsWithDuration: withDuration, sessionsWithoutDuration: Math.max(0, n(stats?.sessions_in_scope) - withDuration),
    };
    const first = n(stats?.firsts), second = n(stats?.seconds), third = n(stats?.thirds);
    response.podiums = { total: first + second + third, first, second, third, available: n(stats?.podium_evidence) > 0 };
    response.sessionTypes.sessionsWithoutDuration = Math.max(0, mineSessions - withDuration);
    return response;
  }).deferred();
}
