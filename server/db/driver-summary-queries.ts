import type { DriverAttributionStint } from "@raceiq/shared/driver-attribution";
import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";
import { classifySessionType, dashboardInstant, dashboardLapMetricFlags, validateDashboardRequest, type DashboardRequest } from "@raceiq/shared/racing/sessions/dashboard";
import type {
  DriverSummary,
  DriverSummaryResponse,
  FavoriteEntity,
  MetricTotals,
  ProfileCoverage,
} from "@raceiq/online/contracts";
import { compareDashboardRanking } from "./dashboard-queries";
import { DASHBOARD_PROCESSOR_VERSION } from "./dashboard-summary-queries";
import { resolveCarName } from "@raceiq/game-catalogs/racing/cars/resolve-name";
import { resolveTrackName } from "@raceiq/game-catalogs/racing/tracks/resolve-name";
import { readOriginalActivitySourceProof, type OriginalActivitySourceProof } from "./original-activity-queries";
import { readClient } from "./index";
import { dashboardLapAttribution, dashboardHasSelfStint, dashboardStints, dashboardDurationAttribution, type DashboardDurationAttribution } from "../driver-summary/dashboard-input";

type Row = Record<string, unknown>;
type Attribution = "Self" | "Other" | "Mixed" | "Unknown";
type SourceLap = {
  sessionId: number; gameId: string; carId: string | null; trackId: string | null; sessionType: string | null;
  createdAtMs: number; originalActivityId: string | null; ownerUserId: string | null; ownership: string;
  sessionAttribution: string | null; sessionStints: DriverAttributionStint[]; elapsedSeconds: number | null;
  durationStatus: string; trackLengthMeters: number | null; lapId: number | null; lapGuid: string | null;
  lapTime: number; valid: boolean; invalidReason: string | null; lapAttribution: Attribution | null;
  lapStints: DriverAttributionStint[]; clockDomain: string | null; lapStartMs: number | null; lapEndMs: number | null;
  stampMs: number;
  sessionInPeriod?: boolean; lapInPeriod?: boolean;
  durationAttribution?: DashboardDurationAttribution | null;
  sessionHasPersonalLap?: boolean;
};

const number = (value: unknown): number => Number(value ?? 0);
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const nullableString = (value: unknown): string | null => value == null ? null : String(value);
const parseStints = dashboardStints;

function sourceAttribution(row: SourceLap): Attribution {
  return dashboardLapAttribution(row.lapStints, row.sessionStints, row.clockDomain, row.lapStartMs, row.lapEndMs);
}

function requestedSessionCohort(request: DashboardRequest): { sql: string; args: (string | number | null)[] } {
  const from = dashboardInstant(request.from), to = dashboardInstant(request.to);
  const game = request.gameId ? " AND game_id=?" : "";
  return { sql: `WITH requested_sessions(session_id) AS (
      SELECT session_id FROM dashboard_session_index WHERE created_at_ms>=? AND created_at_ms<?${game}
      UNION SELECT di.session_id FROM dashboard_lap_index di JOIN dashboard_session_index si ON si.session_id=di.session_id
        WHERE di.created_at_ms>=? AND di.created_at_ms<?${request.gameId ? " AND si.game_id=?" : ""}
      UNION SELECT session_id FROM dashboard_session_days
        WHERE utc_day>=? AND utc_day<=?${game})`,
    args: [from, to, ...(request.gameId ? [request.gameId] : []), from, to, ...(request.gameId ? [request.gameId] : []),
      new Date(from).toISOString().slice(0, 10), new Date(to).toISOString().slice(0, 10), ...(request.gameId ? [request.gameId] : [])] };
}

async function readSourceLaps(ownerUserId: string | null, source: Pick<typeof readClient, "execute"> = readClient,
  request?: DashboardRequest): Promise<SourceLap[]> {
  const cohort = request ? requestedSessionCohort(request) : { sql: "", args: [] };
  const from = request ? dashboardInstant(request.from) : null, to = request ? dashboardInstant(request.to) : null;
  const result = await source.execute({ sql: `${cohort.sql} SELECT s.id session_id,s.game_id,s.car_id,s.track_id,s.session_type,
      si.created_at_ms AS session_created_ms,s.original_activity_id,s.owner_user_id,s.ownership,
      s.driver_attribution session_attribution,s.driver_attribution_stints session_stints,
      p.elapsed_seconds,p.duration_status,
      CASE WHEN st.metadata_dirty=0 AND st.deleted=0
        AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
        AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision
        THEN p.lap_count ELSE 0 END personal_session_laps,
      CASE WHEN st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0
        AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
        AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision
        THEN p.duration_attribution_json ELSE NULL END duration_attribution_json,
      CASE WHEN st.metadata_dirty=0 AND st.capture_dirty=0 AND st.deleted=0
        AND st.processor_version=${DASHBOARD_PROCESSOR_VERSION} AND p.processor_version=${DASHBOARD_PROCESSOR_VERSION}
        AND st.published_revision=st.source_revision AND p.source_revision=st.source_revision
        THEN p.track_length_meters ELSE NULL END track_length_meters,
      l.id lap_id,l.lap_guid,l.lap_time,l.is_valid,l.invalid_reason,l.driver_attribution lap_attribution,
      l.driver_attribution_stints lap_stints,l.source_clock_domain,l.source_lap_start_ms,l.source_lap_end_ms,
      di.created_at_ms lap_created_ms
    FROM sessions s ${request ? "JOIN requested_sessions rs ON rs.session_id=s.id" : ""}
    LEFT JOIN dashboard_session_index si ON si.session_id=s.id
    ${request
      ? "LEFT JOIN dashboard_lap_index di ON di.session_id=s.id AND di.created_at_ms>=? AND di.created_at_ms<? LEFT JOIN laps l ON l.id=di.lap_id"
      : "LEFT JOIN laps l ON l.session_id=s.id LEFT JOIN dashboard_lap_index di ON di.lap_id=l.id"}
    LEFT JOIN dashboard_session_summaries p ON p.session_id=s.id
    LEFT JOIN dashboard_summary_state st ON st.session_id=s.id
    WHERE s.ownership='mine' AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
      AND (s.owner_user_id IS NULL OR s.owner_user_id=?)
      ${request ? "AND (di.lap_id IS NOT NULL OR si.created_at_ms>=? AND si.created_at_ms<?)" : ""}
    ORDER BY s.game_id,s.original_activity_id,s.id,l.id`,
    args: [...cohort.args, ...(request ? [from, to] : []), ownerUserId, ...(request ? [from, to] : [])] });
  const stintsBySession = new Map<number, DriverAttributionStint[]>();
  return (result.rows as unknown as Row[]).map((raw) => {
    const sessionId = number(raw.session_id);
    let sessionStints = stintsBySession.get(sessionId);
    if (!sessionStints) { sessionStints = parseStints(raw.session_stints); stintsBySession.set(sessionId, sessionStints); }
    return {
      sessionId, gameId: String(raw.game_id), carId: nullableString(raw.car_id), trackId: nullableString(raw.track_id),
      sessionType: nullableString(raw.session_type), createdAtMs: number(raw.session_created_ms),
      originalActivityId: nullableString(raw.original_activity_id),
      ownerUserId: nullableString(raw.owner_user_id), ownership: String(raw.ownership),
      sessionAttribution: nullableString(raw.session_attribution), sessionStints,
      elapsedSeconds: nullableNumber(raw.elapsed_seconds), durationStatus: String(raw.duration_status ?? "unavailable"),
      durationAttribution: dashboardDurationAttribution(raw.duration_attribution_json),
      sessionHasPersonalLap: number(raw.personal_session_laps) > 0,
      trackLengthMeters: nullableNumber(raw.track_length_meters), lapId: nullableNumber(raw.lap_id), lapGuid: nullableString(raw.lap_guid),
      lapTime: number(raw.lap_time), valid: number(raw.is_valid) === 1, invalidReason: nullableString(raw.invalid_reason),
      lapAttribution: nullableString(raw.lap_attribution) as Attribution | null, lapStints: parseStints(raw.lap_stints),
      clockDomain: nullableString(raw.source_clock_domain), lapStartMs: nullableNumber(raw.source_lap_start_ms),
      lapEndMs: nullableNumber(raw.source_lap_end_ms), stampMs: number(raw.lap_created_ms),
      sessionInPeriod: from === null || number(raw.session_created_ms) >= from && number(raw.session_created_ms) < to!,
      lapInPeriod: raw.lap_id != null && (from === null || number(raw.lap_created_ms) >= from && number(raw.lap_created_ms) < to!),
    };
  });
}

function emptyMetrics(): MetricTotals {
  return { laps: 0, positiveLaps: 0, validLaps: 0, drivenSeconds: 0, validSeconds: 0, distanceMeters: null,
    sessionTypeSeconds: { practice: 0, qualifying: 0, race: 0, unknown: 0 }, sessionsWithDuration: 0, sessionsWithoutDuration: 0 };
}
type EntityTotal = { gameId: string; nativeId: string; seconds: number; laps: number };
type Accumulator = { metrics: MetricTotals; cars: Map<string, EntityTotal>; tracks: Map<string, EntityTotal>; distanceKnown: boolean };
function accumulator(): Accumulator { return { metrics: emptyMetrics(), cars: new Map(), tracks: new Map(), distanceKnown: true }; }
function addEntity(map: Map<string, EntityTotal>, gameId: string, nativeId: string | null, seconds: number): void {
  if (!nativeId || nativeId === "-1") return;
  const key = JSON.stringify([gameId, nativeId]);
  const item = map.get(key) ?? { gameId, nativeId, seconds: 0, laps: 0 };
  item.seconds += seconds; item.laps++;
  map.set(key, item);
}
function entityContributions(map: Map<string, EntityTotal>): EntityTotal[] {
  return [...map.values()].map(({ gameId, nativeId, seconds, laps }) => ({ gameId, nativeId, seconds, laps }))
    .sort((a, b) => a.gameId.localeCompare(b.gameId) || a.nativeId.localeCompare(b.nativeId));
}
function favorite(entities: EntityTotal[], kind: "car" | "track"): FavoriteEntity | null {
  const entity = [...entities].sort((a, b) => compareDashboardRanking(
    { seconds: a.seconds, laps: a.laps, gameId: a.gameId, identity: a.nativeId },
    { seconds: b.seconds, laps: b.laps, gameId: b.gameId, identity: b.nativeId },
  ))[0];
  if (!entity) return null;
  const name = kind === "car" ? resolveCarName(entity.nativeId, entity.gameId) : resolveTrackName(entity.nativeId, entity.gameId);
  return { nativeId: entity.nativeId, name, seconds: entity.seconds, laps: entity.laps };
}
function summarizeAccumulator(value: Accumulator): { metrics: MetricTotals; favoriteCar: FavoriteEntity | null; favoriteTrack: FavoriteEntity | null } {
  return { metrics: value.metrics, favoriteCar: favorite([...value.cars.values()], "car"), favoriteTrack: favorite([...value.tracks.values()], "track") };
}
function addLap(target: Accumulator, row: SourceLap, attribution: Attribution): void {
  if (attribution !== "Self") return;
  if (row.lapId === null || row.lapInPeriod === false) return;
  const flags = dashboardLapMetricFlags(row.lapTime, row.valid, row.invalidReason);
  target.metrics.laps++;
  if (!flags.positive) return;
  target.metrics.positiveLaps++; target.metrics.drivenSeconds += row.lapTime;
  if (flags.valid) { target.metrics.validLaps++; target.metrics.validSeconds += row.lapTime; }
  if (flags.favouriteEligible) {
    addEntity(target.cars, row.gameId, row.carId, row.lapTime);
    addEntity(target.tracks, row.gameId, row.trackId, row.lapTime);
    if (row.trackLengthMeters !== null && Number.isFinite(row.trackLengthMeters) && row.trackLengthMeters > 0) {
      target.metrics.distanceMeters = (target.metrics.distanceMeters ?? 0) + row.trackLengthMeters;
    } else target.distanceKnown = false;
  }
}
export type DriverSummaryLapFact = SourceLap;
export type ReducedDriverSummary = { summary: DriverSummary; context: DriverSummaryResponse["context"]; coverage: ProfileCoverage };
function* reduceSourceFactSteps(rows: readonly DriverSummaryLapFact[]): Generator<void, { projection: ReducedDriverSummary; total: Accumulator }> {
  const all = accumulator(), byGame = new Map<string, Accumulator>();
  const context = { basis: "positive_lap_time" as const, other: { laps: 0, seconds: 0 }, mixed: { laps: 0, seconds: 0 }, unknown: { laps: 0, seconds: 0 } };
  let identityComplete = true, driverComplete = true;
  const sessions = new Map<number, { row: SourceLap; personalLap: boolean }>();
  let durationPartial = false;
  let processed = 0;
  for (const row of rows) {
    if (++processed % 256 === 0) yield;
    if (row.ownership !== "mine") continue;
    const attribution = sourceAttribution(row);
    const session = sessions.get(row.sessionId) ?? { row, personalLap: dashboardHasSelfStint(row.sessionStints) };
    session.personalLap ||= row.sessionHasPersonalLap === true || row.lapId !== null && attribution === "Self";
    sessions.set(row.sessionId, session);
    if ((row.lapId !== null && !row.lapGuid) || !row.originalActivityId) identityComplete = false;
    if (row.lapId !== null && attribution === "Unknown") driverComplete = false;
    if (attribution === "Other" || attribution === "Mixed" || attribution === "Unknown") {
      if (row.lapId !== null && row.lapInPeriod !== false && row.lapTime > 0 && Number.isFinite(row.lapTime)) {
        const bucket = attribution.toLowerCase() as "other" | "mixed" | "unknown";
        context[bucket].laps++; context[bucket].seconds += row.lapTime;
      }
      continue;
    }
    if (!KNOWN_GAME_IDS.includes(row.gameId as GameId)) continue;
    const game = byGame.get(row.gameId) ?? accumulator();
    addLap(all, row, attribution); addLap(game, row, attribution); byGame.set(row.gameId, game);
  }
  for (const { row, personalLap } of sessions.values()) {
    if (++processed % 256 === 0) yield;
    if (row.sessionInPeriod === false || !KNOWN_GAME_IDS.includes(row.gameId as GameId)) continue;
    const duration = row.durationAttribution;
    if (!personalLap && !duration?.selfObserved) continue;
    const game = byGame.get(row.gameId) ?? accumulator();
    byGame.set(row.gameId, game);
    const measured = duration?.selfObserved && duration.coverage !== "unavailable";
    for (const target of [all, game]) {
      if (measured) {
        target.metrics.sessionsWithDuration++;
        target.metrics.sessionTypeSeconds[classifySessionType(row.sessionType)] += duration.selfSeconds;
      } else target.metrics.sessionsWithoutDuration++;
    }
    durationPartial ||= !measured || duration?.coverage !== "complete";
    if (duration && (duration.unknownSeconds > 0 || duration.coverage !== "complete")) driverComplete = false;
  }
  const coverage: ProfileCoverage = {
    identity: identityComplete ? "complete" : "partial",
    driverAttribution: driverComplete ? "complete" : "partial",
    sessionDuration: all.metrics.sessionsWithDuration === 0 ? "unavailable" : durationPartial ? "partial" : "complete",
    distance: all.distanceKnown ? (all.metrics.distanceMeters !== null ? "complete" : "unavailable") : "partial",
  };
  if (!all.distanceKnown) all.metrics.distanceMeters = null;
  for (const stats of byGame.values()) if (!stats.distanceKnown) stats.metrics.distanceMeters = null;
  return { total: all, projection: { summary: { metrics: all.metrics,
    games: [...byGame.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([gameId, stats]) => ({ gameId, ...summarizeAccumulator(stats) })) },
    context, coverage } };
}

function reduceSourceFacts(rows: readonly DriverSummaryLapFact[]): { projection: ReducedDriverSummary; total: Accumulator } {
  const steps = reduceSourceFactSteps(rows);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}


export function reduceDriverSummaryFacts(rows: readonly DriverSummaryLapFact[]): ReducedDriverSummary {
  return reduceSourceFacts(rows).projection;
}

type LocalDriverSummarySnapshot = { allRows: SourceLap[]; localRevision: number };
async function readLocalDriverSummarySnapshot(request: DashboardRequest, source: Pick<typeof readClient, "execute">): Promise<LocalDriverSummarySnapshot> {
  const cohort = requestedSessionCohort(request);
  const account = await source.execute({ sql: "SELECT online_user_id FROM local_account_owner WHERE id=1" });
  const ownerUserId = nullableString(account.rows[0]?.online_user_id);
  const readiness = await source.execute({ sql: `${cohort.sql} SELECT MAX(st.source_revision) revision,
      SUM(CASE WHEN si.session_id IS NULL OR st.session_id IS NULL OR p.session_id IS NULL
        OR st.metadata_dirty!=0 OR st.deleted!=0 OR st.processor_version!=${DASHBOARD_PROCESSOR_VERSION}
        OR p.processor_version!=${DASHBOARD_PROCESSOR_VERSION} OR st.published_revision!=st.source_revision
        OR p.source_revision!=st.source_revision OR EXISTS(
          SELECT 1 FROM laps l LEFT JOIN dashboard_lap_index di ON di.lap_id=l.id
          WHERE l.session_id=s.id AND di.lap_id IS NULL) THEN 1 ELSE 0 END) pending
    FROM requested_sessions rs JOIN sessions s ON s.id=rs.session_id
    LEFT JOIN dashboard_session_index si ON si.session_id=s.id
    LEFT JOIN dashboard_summary_state st ON st.session_id=s.id
    LEFT JOIN dashboard_session_summaries p ON p.session_id=s.id
    WHERE s.ownership='mine' AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
      AND (s.owner_user_id IS NULL OR s.owner_user_id=?)`,
    args: [...cohort.args, ownerUserId] });
  const state = readiness.rows[0] as Row | undefined;
  if (number(state?.pending) > 0) {
    throw Object.assign(new Error("Driver summary index is building"), { code: "building", status: 202 });
  }
  return { allRows: await readSourceLaps(ownerUserId, source, request), localRevision: number(state?.revision) };
}

export async function buildLocalDriverSummary(request: DashboardRequest): Promise<DriverSummaryResponse> {
  if (!validateDashboardRequest(request)) throw new RangeError("Invalid dashboard request");
  const tx = await readClient.transaction("read");
  let snapshot: LocalDriverSummarySnapshot;
  try {
    snapshot = await readLocalDriverSummarySnapshot(request, tx);
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  const { allRows, localRevision } = snapshot;
  const rows = allRows;
  const representations = await readSourceRepresentations(rows, true);
  const projection = reduceDriverSummaryFacts(rows);
  if (rows.some((row) => !representations.get(row.sessionId)?.proof)) projection.coverage.identity = "partial";
  return { schemaVersion: 2, localRevision,
    generatedAt: new Date().toISOString(), ...projection };
}


function matchesSourceProof(rows: readonly SourceLap[], proof: OriginalActivitySourceProof | null): proof is OriginalActivitySourceProof {
  if (!proof || proof.schemaVersion !== 1 || proof.coverage !== "complete" || !proof.sourceRevision
    || !rows.length) return false;
  const guids = new Set(proof.originalLapGuids);
  const laps = rows.filter((row) => row.lapId !== null);
  return guids.size === proof.originalLapGuids.length && laps.length === guids.size
    && rows.every((row) => row.originalActivityId === proof.originalActivityId && row.ownerUserId === proof.ownerUserId)
    && laps.every((row) => row.lapGuid !== null && guids.delete(row.lapGuid)) && guids.size === 0;
}

async function readSourceRepresentations(rows: readonly SourceLap[], partialPeriod = false) {
  const bySession = new Map<number, SourceLap[]>();
  for (const row of rows) {
    const sessionRows = bySession.get(row.sessionId) ?? [];
    sessionRows.push(row); bySession.set(row.sessionId, sessionRows);
  }
  const representations = new Map<number, { rows: SourceLap[]; proof: OriginalActivitySourceProof | null }>();
  // Serialize authoritative proof reads: no per-session transaction fanout.
  for (const [sessionId, sessionRows] of bySession) {
    const proof = sessionRows.some((row) => !row.originalActivityId || row.lapId !== null && !row.lapGuid)
      ? null : await readOriginalActivitySourceProof(sessionId);
    const periodGuids = partialPeriod && proof ? new Set(proof.originalLapGuids) : null;
    const valid = partialPeriod
      ? proof && sessionRows.every((row) => row.originalActivityId === proof.originalActivityId && row.ownerUserId === proof.ownerUserId
        && (row.lapId === null || row.lapGuid !== null && periodGuids!.has(row.lapGuid)))
      : matchesSourceProof(sessionRows, proof);
    representations.set(sessionId, { rows: sessionRows, proof: valid ? proof : null });
  }
  return representations;
}

