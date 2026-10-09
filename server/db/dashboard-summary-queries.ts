import { client } from "./index";
import { dashboardCarIdentity, dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import type { GameId } from "@raceiq/shared/games/ids";

export const DASHBOARD_PROCESSOR_VERSION = 4;
const LAP_PAGE_SIZE = 256;
const TIME_BUCKET_MS = 15 * 60 * 1000;

export type EvidenceStatus = "available" | "unavailable" | "pending";
export interface DashboardCaptureFacts {
  sourceRevision: number;
  captureRevision: string;
  duration: { status: EvidenceStatus; elapsedSeconds: number | null };
  sectorLayout: { status: EvidenceStatus; key: string; sectorCount: number } | null;
  weather: { status: EvidenceStatus; revision: string | null };
  trackLengthMeters: number | null;
}
type DbRow = Record<string, unknown>;
export interface DashboardPublicationCandidate {
  readonly sessionId: number;
  readonly sourceRevision: number;
  readonly deleted: boolean;
  readonly captureDirty: boolean;
  readonly session: Readonly<DbRow> | null;
}
interface DashboardTransaction {
  execute(statement: { sql: string; args?: (string | number | null)[] }): Promise<{ rows: DbRow[] }>;
}
type DayContribution = {
  utc_day: string; game_id: string; car_key: string; track_key: string;
  lap_count: number; positive_laps: number; valid_laps: number;
  driven_seconds: number; valid_seconds: number; best_lap_seconds: number | null; mean_lap_seconds: number | null; m2_lap_seconds: number | null;
  favourite_laps: number; favourite_seconds: number; distance_laps: number; distance_meters: number | null;
  podium_first: number; podium_second: number; podium_third: number;
};
type TimeContribution = {
  bucket_start_ms: number; game_id: string; valid_laps: number; positive_laps: number;
  driven_seconds: number; valid_seconds: number; podium_first: number; podium_second: number; podium_third: number;
};
type LapAggregate = DayContribution;
type Moment = { count: number; mean: number; m2: number };
const number = (value: unknown): number => Number(value ?? 0);
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const stringOrNull = (value: unknown): string | null => value == null ? null : String(value);
function timestamp(value: unknown): number {
  const raw = String(value ?? "");
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const result = Date.parse(naive ? `${raw.replace(" ", "T")}Z` : raw);
  if (!Number.isFinite(result)) throw new RangeError("Invalid dashboard source timestamp");
  return result;
}
function mergeMoments(left: Moment, right: Moment): Moment {
  if (!left.count) return right;
  if (!right.count) return left;
  const count = left.count + right.count;
  const delta = right.mean - left.mean;
  return { count, mean: left.mean + delta * right.count / count, m2: left.m2 + right.m2 + delta * delta * left.count * right.count / count };
}
function removeMoments(total: Moment, removed: Moment): Moment {
  if (!removed.count) return total;
  if (removed.count > total.count) throw new Error("Dashboard contribution count underflow");
  if (removed.count === total.count) return { count: 0, mean: 0, m2: 0 };
  const count = total.count - removed.count;
  const mean = (total.count * total.mean - removed.count * removed.mean) / count;
  const delta = removed.mean - total.mean;
  const m2 = total.m2 - removed.m2 - delta * delta * count * removed.count / total.count;
  if (!Number.isFinite(mean) || !Number.isFinite(m2) || m2 < -Math.max(1e-9, Math.abs(total.m2) * 1e-12)) {
    throw new RangeError("Invalid dashboard moment subtraction");
  }
  return { count, mean, m2: Math.max(0, m2) };
}
function stats(row: DbRow, countName: string, meanName: string, m2Name: string): Moment {
  return { count: number(row[countName]), mean: number(row[meanName]), m2: number(row[m2Name]) };
}
const DAY_COLUMNS = ["lap_count", "positive_laps", "valid_laps", "driven_seconds", "valid_seconds", "favourite_laps", "favourite_seconds", "distance_laps", "distance_meters", "podium_first", "podium_second", "podium_third"] as const;
async function adjustDayEntity(tx: DashboardTransaction, row: DayContribution, sign: 1 | -1): Promise<void> {
  const keyArgs = [row.utc_day, row.game_id, row.car_key, row.track_key];
  const result = await tx.execute({ sql: "SELECT * FROM dashboard_day_entities WHERE utc_day=? AND game_id=? AND car_key=? AND track_key=?", args: keyArgs });
  const current = result.rows[0] as DbRow | undefined;
  const contribution = (field: typeof DAY_COLUMNS[number]) => number(row[field]);
  const currentValues = Object.fromEntries(DAY_COLUMNS.map((field) => [field, number(current?.[field])])) as Record<typeof DAY_COLUMNS[number], number>;
  const next = Object.fromEntries(DAY_COLUMNS.map((field) => [field, currentValues[field] + sign * contribution(field)])) as Record<typeof DAY_COLUMNS[number], number>;
  for (const field of ["lap_count", "positive_laps", "valid_laps", "favourite_laps", "distance_laps", "podium_first", "podium_second", "podium_third"] as const) {
    if (next[field] < 0) throw new Error(`Dashboard ${field} contribution underflow`);
  }
  const currentMoments = current ? stats(current, "valid_laps", "valid_mean_seconds", "valid_m2_seconds") : { count: 0, mean: 0, m2: 0 };
  const contributionMoments = { count: number(row.valid_laps), mean: number(row.mean_lap_seconds), m2: number(row.m2_lap_seconds) };
  const moments = sign === 1 ? mergeMoments(currentMoments, contributionMoments) : removeMoments(currentMoments, contributionMoments);
  if (next.lap_count === 0 && next.podium_first === 0 && next.podium_second === 0 && next.podium_third === 0) {
    await tx.execute({ sql: "DELETE FROM dashboard_day_entities WHERE utc_day=? AND game_id=? AND car_key=? AND track_key=?", args: keyArgs });
    return;
  }
  const fields = [...DAY_COLUMNS, "valid_mean_seconds", "valid_m2_seconds"] as const;
  const values = [...fields.map((field) => field === "valid_mean_seconds" ? (moments.count ? moments.mean : null)
    : field === "valid_m2_seconds" ? (moments.count ? moments.m2 : null) : next[field])];
  await tx.execute({
    sql: `INSERT INTO dashboard_day_entities(utc_day, game_id, car_key, track_key, ${fields.join(", ")})
      VALUES (?, ?, ?, ?, ${fields.map(() => "?").join(",")})
      ON CONFLICT(utc_day, game_id, car_key, track_key) DO UPDATE SET ${fields.map((field) => `${field}=excluded.${field}`).join(", ")}`,
    args: [...keyArgs, ...values],
  });
}
async function adjustTimeBucket(tx: DashboardTransaction, row: TimeContribution, sign: 1 | -1): Promise<void> {
  const keys = [row.bucket_start_ms, row.game_id];
  const existing = await tx.execute({ sql: "SELECT * FROM dashboard_time_buckets WHERE bucket_start_ms=? AND game_id=?", args: keys });
  const current = existing.rows[0] as DbRow | undefined;
  const fields = ["valid_laps", "positive_laps", "driven_seconds", "valid_seconds", "podium_first", "podium_second", "podium_third"] as const;
  const next = Object.fromEntries(fields.map((field) => [field, number(current?.[field]) + sign * number(row[field])])) as Record<typeof fields[number], number>;
  for (const field of ["valid_laps", "positive_laps", "podium_first", "podium_second", "podium_third"] as const) if (next[field] < 0) throw new Error(`Dashboard ${field} bucket underflow`);
  if (next.valid_laps === 0 && next.positive_laps === 0 && next.podium_first === 0 && next.podium_second === 0 && next.podium_third === 0) {
    await tx.execute({ sql: "DELETE FROM dashboard_time_buckets WHERE bucket_start_ms=? AND game_id=?", args: keys });
  } else {
    await tx.execute({
      sql: `INSERT INTO dashboard_time_buckets(bucket_start_ms, game_id, ${fields.join(", ")}) VALUES (?, ?, ${fields.map(() => "?").join(",")})
        ON CONFLICT(bucket_start_ms, game_id) DO UPDATE SET ${fields.map((field) => `${field}=excluded.${field}`).join(", ")}`,
      args: [...keys, ...fields.map((field) => next[field])],
    });
  }
}

/** Snapshot candidate before expensive work. Evidence must carry this exact revision. */
export async function prepareDashboardPublicationCandidate(sessionId: number): Promise<DashboardPublicationCandidate | null> {
  const result = await client.execute({
    sql: `SELECT st.source_revision, st.deleted, st.capture_dirty, s.id, s.game_id, s.ownership, s.created_at,
        s.car_id, s.track_id, s.car_ordinal, s.track_ordinal, s.session_type, s.raw_file, s.source,
        s.capture_format_version, r.outcome_status, r.classification, r.finishing_position
      FROM dashboard_summary_state st LEFT JOIN sessions s ON s.id=st.session_id
      LEFT JOIN session_results r ON r.session_id=s.id WHERE st.session_id=?`,
    args: [sessionId],
  });
  const row = result.rows[0] as DbRow | undefined;
  if (!row) return null;
  const session = row.id == null ? null : Object.freeze({ ...row });
  return Object.freeze({
    sessionId,
    sourceRevision: number(row.source_revision),
    deleted: number(row.deleted) !== 0,
    captureDirty: number(row.capture_dirty) !== 0,
    session,
  });
}

/** Build exact session/day/time contributions, then atomically replace them iff candidate revision remains current. */
export async function publishDashboardSession(candidate: DashboardPublicationCandidate, evidence?: DashboardCaptureFacts): Promise<boolean> {
  const { sessionId, sourceRevision: revision, session } = candidate;
  if (evidence && (evidence.sourceRevision !== revision || !evidence.captureRevision.trim()
    || !["available", "unavailable", "pending"].includes(evidence.duration.status)
    || (evidence.duration.status === "available" && (!Number.isFinite(evidence.duration.elapsedSeconds) || evidence.duration.elapsedSeconds! < 0))
    || (evidence.sectorLayout?.status === "available" && (!evidence.sectorLayout.key.trim()
      || !Number.isInteger(evidence.sectorLayout.sectorCount) || evidence.sectorLayout.sectorCount < 1 || evidence.sectorLayout.sectorCount > 16))
    || !["available", "unavailable", "pending"].includes(evidence.weather.status)
    || (evidence.trackLengthMeters !== null && (!Number.isFinite(evidence.trackLengthMeters) || evidence.trackLengthMeters <= 0)))) {
    throw new RangeError("Invalid or stale dashboard capture evidence");
  }
  const priorResult = await client.execute({ sql: "SELECT * FROM dashboard_session_summaries WHERE session_id=?", args: [sessionId] });
  const prior = priorResult.rows[0] as DbRow | undefined;
  const preserveCapture = !evidence && !candidate.captureDirty && !!prior;
  const gameId = session ? String(session.game_id) : "";
  const excluded = !session || candidate.deleted || session.ownership !== "mine";
  const trackKeyForSectors = session
    ? dashboardTrackIdentity(gameId as GameId, session.track_id as string | number | null, nullableNumber(session.track_ordinal))
    : null;
  const sectorLayoutKey = evidence ? (evidence.sectorLayout?.status === "available" ? evidence.sectorLayout.key : null)
    : preserveCapture && prior && stringOrNull(prior.track_key) === trackKeyForSectors ? stringOrNull(prior.sector_layout_key) : null;
  const sectorCount = evidence ? (evidence.sectorLayout?.status === "available" ? evidence.sectorLayout.sectorCount : null)
    : sectorLayoutKey ? nullableNumber(prior?.sector_count) : null;
  const elapsedSeconds = evidence ? (evidence.duration.status === "available" ? evidence.duration.elapsedSeconds : null)
    : preserveCapture ? nullableNumber(prior?.elapsed_seconds) : null;
  const durationStatus = evidence?.duration.status ?? (preserveCapture ? String(prior?.duration_status ?? "pending") : "pending");
  const weatherRevision = evidence ? evidence.weather.revision : preserveCapture ? stringOrNull(prior?.weather_revision) : null;
  const weatherStatus = evidence?.weather.status ?? (preserveCapture ? String(prior?.weather_status ?? "pending") : "pending");
  const captureRevision = evidence?.captureRevision ?? (preserveCapture ? stringOrNull(prior?.capture_revision) : null);
  const evidenceVersion = evidence ? DASHBOARD_PROCESSOR_VERSION : preserveCapture ? number(prior?.evidence_version) : 0;
  const trackLengthMeters = evidence?.trackLengthMeters ?? (preserveCapture ? nullableNumber(prior?.track_length_meters) : null);
  const sectors = sectorLayoutKey && sectorCount ? Array<number | null>(sectorCount).fill(null) : [];
  const entityMap = new Map<string, LapAggregate>();
  const bucketMap = new Map<number, TimeContribution>();
  let lapCount = 0, positiveLaps = 0, validLaps = 0, drivenSeconds = 0, validSeconds = 0;
  let validMean = 0, validM2 = 0, bestLap: number | null = null, firstLapAt: number | null = null, lastLapAt: number | null = null;
  let favouriteLaps = 0, favouriteSeconds = 0, distanceLaps = 0, distanceMeters = 0, lastLapId = 0;
  if (!excluded && session) {
    const carKey = dashboardCarIdentity(gameId as GameId, session.car_id as string | number | null, nullableNumber(session.car_ordinal)) ?? "";
    const trackKey = dashboardTrackIdentity(gameId as GameId, session.track_id as string | number | null, nullableNumber(session.track_ordinal)) ?? "";
    for (;;) {
      const page = await client.execute({ sql: `SELECT lap_id, created_at_ms, lap_time, is_valid, invalid_reason, sector_times
        FROM dashboard_lap_index WHERE session_id=? AND lap_id>? ORDER BY lap_id LIMIT ?`, args: [sessionId, lastLapId, LAP_PAGE_SIZE] });
      if (!page.rows.length) break;
      for (const raw of page.rows as unknown as DbRow[]) {
        lastLapId = number(raw.lap_id);
        const stamp = number(raw.created_at_ms), time = number(raw.lap_time), valid = number(raw.is_valid) === 1;
        if (!Number.isFinite(stamp)) throw new RangeError("Invalid dashboard lap timestamp");
        lapCount++;
        const day = new Date(stamp).toISOString().slice(0, 10), dayKey = `${day}\0${carKey}\0${trackKey}`;
        let entity = entityMap.get(dayKey);
        if (!entity) {
          entity = { utc_day: day, game_id: gameId, car_key: carKey, track_key: trackKey, lap_count: 0,
            positive_laps: 0, valid_laps: 0, driven_seconds: 0, valid_seconds: 0, best_lap_seconds: null, mean_lap_seconds: 0, m2_lap_seconds: 0,
            favourite_laps: 0, favourite_seconds: 0, distance_laps: 0, distance_meters: 0,
            podium_first: 0, podium_second: 0, podium_third: 0 };
          entityMap.set(dayKey, entity);
        }
        entity.lap_count++;
        const bucketStart = Math.floor(stamp / TIME_BUCKET_MS) * TIME_BUCKET_MS;
        let bucket = bucketMap.get(bucketStart);
        if (!bucket) {
          bucket = { bucket_start_ms: bucketStart, game_id: gameId, valid_laps: 0, positive_laps: 0, driven_seconds: 0,
            valid_seconds: 0, podium_first: 0, podium_second: 0, podium_third: 0 };
          bucketMap.set(bucketStart, bucket);
        }
        if (!(time > 0) || !Number.isFinite(time)) continue;
        positiveLaps++; drivenSeconds += time; entity.positive_laps++; entity.driven_seconds += time;
        bucket.positive_laps++; bucket.driven_seconds += time;
        if (String(raw.invalid_reason ?? "") !== "incomplete") {
          favouriteLaps++; favouriteSeconds += time;
          entity.favourite_laps++; entity.favourite_seconds += time;
          if (trackLengthMeters !== null) { distanceLaps++; distanceMeters += trackLengthMeters; entity.distance_laps++; entity.distance_meters! += trackLengthMeters; }
        }
        if (valid) {
          validLaps++; validSeconds += time; bestLap = bestLap === null ? time : Math.min(bestLap, time);
          const nextCount = validLaps, delta = time - validMean;
          validMean += delta / nextCount; validM2 += delta * (time - validMean);
          entity.valid_laps++; entity.valid_seconds += time;
          const entityDelta = time - number(entity.mean_lap_seconds);
          entity.mean_lap_seconds = number(entity.mean_lap_seconds) + entityDelta / entity.valid_laps;
          entity.m2_lap_seconds = number(entity.m2_lap_seconds) + entityDelta * (time - entity.mean_lap_seconds);
          bucket.valid_laps++; bucket.valid_seconds += time;
          firstLapAt = firstLapAt === null ? stamp : Math.min(firstLapAt, stamp); lastLapAt = lastLapAt === null ? stamp : Math.max(lastLapAt, stamp);
          if (sectors.length && raw.sector_times != null) {
            try {
              const values: unknown = JSON.parse(String(raw.sector_times));
              if (Array.isArray(values) && values.length === sectors.length && values.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
                values.forEach((value, index) => { sectors[index] = sectors[index] === null ? value as number : Math.min(sectors[index]!, value as number); });
              }
            } catch { /* Invalid lap sector payload contributes no sector minimum. */ }
          }
        }
      }
      if (page.rows.length < LAP_PAGE_SIZE) break;
    }
  }
  const createdAtMs = session ? timestamp(session.created_at) : 0;
  const podium = session?.session_type != null && String(session.session_type).trim().toLowerCase().startsWith("race")
    && session.outcome_status === "confirmed" && session.classification === "finished"
    && Number.isInteger(Number(session.finishing_position)) && number(session.finishing_position) > 0
    ? number(session.finishing_position) : 0;
  if (!excluded && podium > 0) {
    const day = new Date(createdAtMs).toISOString().slice(0, 10);
    const dayKey = `${day}\0${dashboardCarIdentity(gameId as GameId, session!.car_id as string | number | null, nullableNumber(session!.car_ordinal)) ?? ""}\0${dashboardTrackIdentity(gameId as GameId, session!.track_id as string | number | null, nullableNumber(session!.track_ordinal)) ?? ""}`;
    let entity = entityMap.get(dayKey);
    if (!entity) {
      entity = { utc_day: day, game_id: gameId, car_key: dashboardCarIdentity(gameId as GameId, session!.car_id as string | number | null, nullableNumber(session!.car_ordinal)) ?? "",
        track_key: dashboardTrackIdentity(gameId as GameId, session!.track_id as string | number | null, nullableNumber(session!.track_ordinal)) ?? "",
        lap_count: 0, positive_laps: 0, valid_laps: 0, driven_seconds: 0, valid_seconds: 0, best_lap_seconds: null, mean_lap_seconds: 0, m2_lap_seconds: 0,
        favourite_laps: 0, favourite_seconds: 0, distance_laps: 0, distance_meters: 0, podium_first: 0, podium_second: 0, podium_third: 0 };
      entityMap.set(dayKey, entity);
    }
    if (podium === 1) entity.podium_first++; else if (podium === 2) entity.podium_second++; else if (podium === 3) entity.podium_third++;
    const bucketStart = Math.floor(createdAtMs / TIME_BUCKET_MS) * TIME_BUCKET_MS;
    let bucket = bucketMap.get(bucketStart);
    if (!bucket) {
      bucket = { bucket_start_ms: bucketStart, game_id: gameId, valid_laps: 0, positive_laps: 0, driven_seconds: 0,
        valid_seconds: 0, podium_first: 0, podium_second: 0, podium_third: 0 };
      bucketMap.set(bucketStart, bucket);
    }
    if (podium === 1) bucket.podium_first++; else if (podium === 2) bucket.podium_second++; else if (podium === 3) bucket.podium_third++;
  }
  const tx = await client.transaction("write");
  try {
    const latest = await tx.execute({ sql: "SELECT source_revision, metadata_dirty, capture_dirty, published_revision, processor_version, deleted FROM dashboard_summary_state WHERE session_id=?", args: [sessionId] });
    const currentState = latest.rows[0] as DbRow | undefined;
    if (!currentState || number(currentState.source_revision) !== revision) { await tx.rollback(); return false; }
    const alreadyPublished = number(currentState.published_revision) === revision && number(currentState.processor_version) === DASHBOARD_PROCESSOR_VERSION
      && number(currentState.metadata_dirty) === 0 && number(currentState.capture_dirty) === 0 && number(currentState.deleted) === 0;
    if (alreadyPublished && !candidate.deleted && !excluded) { await tx.rollback(); return true; }
    const oldDays = await tx.execute({ sql: "SELECT * FROM dashboard_session_days WHERE session_id=?", args: [sessionId] });
    for (const row of oldDays.rows as unknown as DayContribution[]) await adjustDayEntity(tx, row, -1);
    const oldBuckets = await tx.execute({ sql: "SELECT * FROM dashboard_session_time_buckets WHERE session_id=?", args: [sessionId] });
    for (const row of oldBuckets.rows as unknown as TimeContribution[]) await adjustTimeBucket(tx, row, -1);
    for (const table of ["dashboard_session_summaries", "dashboard_session_days", "dashboard_session_sectors", "dashboard_session_time_buckets"]) {
      await tx.execute({ sql: `DELETE FROM ${table} WHERE session_id=?`, args: [sessionId] });
    }
    if (!excluded && session) {
      await tx.execute({
        sql: `INSERT INTO dashboard_session_summaries(session_id,source_revision,processor_version,game_id,created_at_ms,car_key,track_key,car_id,track_id,car_ordinal,track_ordinal,session_type,lap_count,positive_laps,valid_laps,driven_seconds,valid_seconds,valid_mean_seconds,valid_m2_seconds,best_lap_seconds,first_lap_at_ms,last_lap_at_ms,favourite_laps,favourite_seconds,distance_laps,distance_meters,track_length_meters,elapsed_seconds,duration_status,sector_layout_key,sector_count,sector_status,podium_position,podium_status,capture_revision,weather_revision,weather_status,evidence_version)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [sessionId,revision,DASHBOARD_PROCESSOR_VERSION,gameId,createdAtMs,
          dashboardCarIdentity(gameId as GameId,session.car_id as string|number|null,nullableNumber(session.car_ordinal)),
          dashboardTrackIdentity(gameId as GameId,session.track_id as string|number|null,nullableNumber(session.track_ordinal)),
          stringOrNull(session.car_id),stringOrNull(session.track_id),nullableNumber(session.car_ordinal),nullableNumber(session.track_ordinal),stringOrNull(session.session_type),
          lapCount,positiveLaps,validLaps,drivenSeconds,validSeconds,validLaps ? validMean : null,validLaps ? validM2 : null,bestLap,firstLapAt,lastLapAt,
          favouriteLaps,favouriteSeconds,distanceLaps,distanceLaps ? distanceMeters : null,trackLengthMeters,elapsedSeconds,durationStatus,sectorLayoutKey,sectorCount,
          evidence ? (evidence.sectorLayout?.status ?? "unavailable") : (sectorLayoutKey ? "available" : preserveCapture ? String(prior?.sector_status ?? "pending") : "pending"),
          podium,session.outcome_status === "confirmed" ? "confirmed" : "unavailable",
          captureRevision,weatherRevision,weatherStatus,evidenceVersion],
      });
      for (const row of entityMap.values()) {
        await tx.execute({ sql: `INSERT INTO dashboard_session_days(session_id,utc_day,game_id,car_key,track_key,lap_count,positive_laps,valid_laps,driven_seconds,valid_seconds,best_lap_seconds,mean_lap_seconds,m2_lap_seconds,favourite_laps,favourite_seconds,distance_laps,distance_meters,podium_first,podium_second,podium_third)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [sessionId,row.utc_day,row.game_id,row.car_key,row.track_key,row.lap_count,row.positive_laps,row.valid_laps,row.driven_seconds,row.valid_seconds,
            row.best_lap_seconds,row.valid_laps ? row.mean_lap_seconds : null,row.valid_laps ? row.m2_lap_seconds : null,row.favourite_laps,row.favourite_seconds,row.distance_laps,
            row.distance_laps ? row.distance_meters : null,row.podium_first,row.podium_second,row.podium_third] });
        await adjustDayEntity(tx, row, 1);
      }
      for (const row of bucketMap.values()) {
        await tx.execute({ sql: `INSERT INTO dashboard_session_time_buckets(session_id,bucket_start_ms,game_id,valid_laps,positive_laps,driven_seconds,valid_seconds,podium_first,podium_second,podium_third)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, args: [sessionId,row.bucket_start_ms,row.game_id,row.valid_laps,row.positive_laps,row.driven_seconds,row.valid_seconds,row.podium_first,row.podium_second,row.podium_third] });
        await adjustTimeBucket(tx, row, 1);
      }
      if (sectorLayoutKey && sectorCount && sectors.length === sectorCount && sectors.every((value): value is number => value !== null)) {
        for (let i = 0; i < sectorCount; i++) await tx.execute({ sql: "INSERT INTO dashboard_session_sectors(session_id,layout_key,sector_index,best_seconds) VALUES (?,?,?,?)", args: [sessionId,sectorLayoutKey,i,sectors[i]] });
      }
    }
    const evidenceReady = !candidate.captureDirty || (!!evidence && evidence.duration.status !== "pending"
      && evidence.weather.status !== "pending" && evidence.sectorLayout?.status !== "pending");
    await tx.execute({
      sql: `UPDATE dashboard_summary_state SET published_revision=?,processor_version=?,metadata_dirty=0,
        capture_dirty=CASE WHEN ? THEN 0 ELSE capture_dirty END,deleted=?,last_success_at=CASE WHEN ? THEN datetime('now') ELSE last_success_at END,
        retry_count=0,next_retry_at=NULL,last_error_code=NULL,updated_at=datetime('now') WHERE session_id=? AND source_revision=?`,
      args: [revision,DASHBOARD_PROCESSOR_VERSION,evidenceReady ? 1 : 0,candidate.deleted ? 1 : 0,evidenceReady ? 1 : 0,sessionId,revision],
    });
    await tx.commit();
    return true;
  } catch (error) { await tx.rollback(); throw error; }
}

export async function publishNextDashboardSession(): Promise<number | null> {
  const result = await client.execute({ sql: `SELECT st.session_id FROM dashboard_summary_state st
    LEFT JOIN dashboard_session_summaries p ON p.session_id=st.session_id
    WHERE (st.metadata_dirty=1 OR st.capture_dirty=1 OR st.processor_version!=? OR st.published_revision!=st.source_revision OR (st.deleted=0 AND p.session_id IS NULL))
      AND (st.next_retry_at IS NULL OR st.next_retry_at<=datetime('now'))
      AND (st.deleted=1 OR EXISTS(SELECT 1 FROM sessions s WHERE s.id=st.session_id AND s.ownership='mine') OR p.session_id IS NOT NULL)
    ORDER BY st.session_id LIMIT 1`, args: [DASHBOARD_PROCESSOR_VERSION] });
  if (!result.rows.length) return null;
  const id = number((result.rows[0] as DbRow).session_id);
  const candidate = await prepareDashboardPublicationCandidate(id);
  return candidate && await publishDashboardSession(candidate) ? id : null;
}
