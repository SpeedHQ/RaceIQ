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
import {
  getDriverSummaryActivity,
  listDriverSummaryActivities,
  listReadyDriverSummaryActivityPage,
  putDriverSummaryActivity,
  recordDriverSummaryActivityHold,
  recordDriverSummaryActivityConfirmation,
  type DriverSummaryActivityInput,
  type DriverSummaryActivityState,
} from "./driver-summary-ledger-queries";
import { getLocalAccountOwner } from "./local-account-queries";
import { readOriginalActivitySourceProof, type OriginalActivitySourceProof } from "./original-activity-queries";
import { readClient } from "./index";
import { dashboardLapAttribution, dashboardHasSelfStint, dashboardStints, dashboardDurationAttribution, type DashboardDurationAttribution } from "../driver-summary/dashboard-input";
import { readDirtyDriverSummaryPreparations, settleDriverSummaryPreparation, type DriverSummaryPreparationSnapshot } from "../driver-summary/preparation";
type ActivityContribution = {
  schemaVersion: 2;
  activityId: string;
  lapGuids: string[];
  expectedRevision: number | null;
  contentHash: string;
  gameId: string;
  metrics: MetricTotals;
  cars: EntityContribution[];
  tracks: EntityContribution[];
  coverage: ProfileCoverage;
};
type EntityContribution = { gameId: string; nativeId: string; seconds: number; laps: number };
export type ActivityContributionHashPayload = Omit<ActivityContribution, "expectedRevision" | "contentHash">;
export type DriverSummaryActivityContribution = ActivityContribution;
export type ActivityContributionHash = (payload: ActivityContributionHashPayload) => string | Promise<string>;
export type PreparedDriverSummaryContribution = DriverSummaryActivityInput;
export type DriverSummaryContributionRecord = {
  activityId: string; ownerUserId: string | null; gameId: string; lapGuidsJson: string; payloadJson: string;
  contentHash: string; expectedCloudRevision: number | null; cloudRevision: number | null; receiptJson: string | null;
  heldCloudRevision: number | null; heldReceiptJson: string | null;
  state: DriverSummaryActivityState; heldReason: string | null; updatedAt: string;
};

type Row = Record<string, unknown>;
type Attribution = "Self" | "Other" | "Mixed" | "Unknown";
type SourceLap = {
  sessionId: number; gameId: string; carId: string | null; trackId: string | null; sessionType: string | null;
  createdAtMs: number; originalActivityId: string | null; nativeCaptureOrigin: boolean; ownerUserId: string | null; ownership: string;
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
  request?: DashboardRequest, activityIds?: readonly string[]): Promise<SourceLap[]> {
  if (activityIds?.length === 0) return [];
  const cohort = request ? requestedSessionCohort(request) : { sql: "", args: [] };
  const from = request ? dashboardInstant(request.from) : null, to = request ? dashboardInstant(request.to) : null;
  const result = await source.execute({ sql: `${cohort.sql} SELECT s.id session_id,s.game_id,s.car_id,s.track_id,s.session_type,
      si.created_at_ms AS session_created_ms,s.original_activity_id,s.native_capture_origin,s.owner_user_id,s.ownership,
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
      ${activityIds ? `AND s.original_activity_id IN (${activityIds.map(() => "?").join(",")})` : ""}
    ORDER BY s.game_id,s.original_activity_id,s.id,l.id`,
    args: [...cohort.args, ...(request ? [from, to] : []), ownerUserId, ...(request ? [from, to] : []), ...(activityIds ?? [])] });
  const stintsBySession = new Map<number, DriverAttributionStint[]>();
  return (result.rows as unknown as Row[]).map((raw) => {
    const sessionId = number(raw.session_id);
    let sessionStints = stintsBySession.get(sessionId);
    if (!sessionStints) { sessionStints = parseStints(raw.session_stints); stintsBySession.set(sessionId, sessionStints); }
    return {
      sessionId, gameId: String(raw.game_id), carId: nullableString(raw.car_id), trackId: nullableString(raw.track_id),
      sessionType: nullableString(raw.session_type), createdAtMs: number(raw.session_created_ms),
      originalActivityId: nullableString(raw.original_activity_id), nativeCaptureOrigin: number(raw.native_capture_origin) === 1,
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
function entityContributions(map: Map<string, EntityTotal>): EntityContribution[] {
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

function yieldPreparation(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
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

async function contributionMetrics(rows: readonly SourceLap[]): Promise<{ metrics: MetricTotals; cars: EntityContribution[]; tracks: EntityContribution[]; coverage: ProfileCoverage }> {
  const steps = reduceSourceFactSteps(rows);
  let step = steps.next();
  while (!step.done) { await yieldPreparation(); step = steps.next(); }
  const { total, projection } = step.value;
  return { metrics: projection.summary.metrics,
    cars: entityContributions(total.cars), tracks: entityContributions(total.tracks), coverage: projection.coverage };
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

/** Local source gaps have local addresses, never fabricated global activity receipts. */
export async function getLocalDriverSummaryHolds(): Promise<{ heldAmbiguous: number; heldLaps: number }> {
  const owner = await getLocalAccountOwner();
  const result = await readClient.execute({ sql: `WITH source_holds AS (
      SELECT COALESCE(s.original_activity_id,'session:'||s.id) source_key,
        MAX(CASE WHEN p.original_activity_id IS NULL OR p.prepared_generation IS NULL OR p.generation<>p.prepared_generation OR p.hold_reason IS NOT NULL THEN 1 ELSE 0 END) unresolved,
        MAX(COALESCE(p.held_laps,0)) cached_held_laps,COUNT(l.id) unresolved_laps
      FROM sessions s LEFT JOIN original_activity_preparations p ON p.original_activity_id=s.original_activity_id
      LEFT JOIN laps l ON l.session_id=s.id
        AND (p.original_activity_id IS NULL OR p.prepared_generation IS NULL OR p.generation<>p.prepared_generation OR p.hold_reason IS NOT NULL)
      WHERE s.ownership='mine' AND s.cloud_import_origin IS NULL AND s.cloud_import_lap_id IS NULL
        AND (s.owner_user_id IS NULL OR s.owner_user_id=?)
      GROUP BY source_key)
    SELECT SUM(unresolved=1 OR cached_held_laps>0) held_ambiguous,
      SUM(CASE WHEN unresolved=1 THEN unresolved_laps ELSE cached_held_laps END) held_laps FROM source_holds`, args: [owner] });
  return { heldAmbiguous: number(result.rows[0]?.held_ambiguous), heldLaps: number(result.rows[0]?.held_laps) };
}

export async function prepareDriverSummaryContributions(hash: ActivityContributionHash): Promise<PreparedDriverSummaryContribution[]> {
  if (typeof hash !== "function") throw new TypeError("A verified v2 activity contribution hash provider is required");
  const accountOwner = await getLocalAccountOwner();
  const sources = await readDirtyDriverSummaryPreparations();
  if (!sources.length) return [];
  const rows = await readSourceLaps(accountOwner, readClient, undefined, sources.map((source) => source.activityId));
  const representations = await readSourceRepresentations(rows);
  const groups = new Map<string, SourceLap[]>();
  let grouped = 0;
  for (const row of rows) if (row.originalActivityId) {
    if (++grouped % 256 === 0) await yieldPreparation();
    const group = groups.get(row.originalActivityId) ?? [];
    group.push(row); groups.set(row.originalActivityId, group);
  }
  const guidOwners = new Map<string, Set<string>>();
  const priorByGuid = new Map<string, string>();
  const guids = [...new Set(rows.flatMap((row) => row.lapGuid ? [row.lapGuid] : []))];
  for (let offset = 0; offset < guids.length; offset += 256) {
    const page = guids.slice(offset, offset + 256), placeholders = page.map(() => "?").join(",");
    const [live, historical] = await Promise.all([
      readClient.execute({ sql: `SELECT l.lap_guid,s.original_activity_id FROM laps l JOIN sessions s ON s.id=l.session_id
        WHERE l.lap_guid IN (${placeholders}) AND s.original_activity_id IS NOT NULL`, args: page }),
      readClient.execute({ sql: `SELECT lap_guid,activity_id FROM driver_summary_activity_laps
        WHERE lap_guid IN (${placeholders})`, args: page }),
    ]);
    for (const row of live.rows) {
      const guid = String(row.lap_guid), owners = guidOwners.get(guid) ?? new Set<string>();
      owners.add(String(row.original_activity_id)); guidOwners.set(guid, owners);
    }
    for (const row of historical.rows) priorByGuid.set(String(row.lap_guid), String(row.activity_id));
  }
  const results: PreparedDriverSummaryContribution[] = [];
  for (const source of sources) {
    const activityId = source.activityId, activityRows = groups.get(activityId) ?? [];
    const snapshot: DriverSummaryPreparationSnapshot = { schemaVersion: 1, contentHash: null,
      heldLaps: activityRows.filter((row) => row.lapId !== null).length, payload: null };
    let preparationHold: string | null = "Full original source membership and coverage are unavailable";
    const resultStart = results.length;
    let failed = false;
    let published = false;
    const publish = async (input: DriverSummaryActivityInput) => {
      await putDriverSummaryActivity(input, {
        originalActivityGeneration: source.generation, snapshotJson: JSON.stringify(snapshot), holdReason: preparationHold,
      });
      published = true;
    };
    const retainWithState = async (prior: DriverSummaryContributionRecord, state: DriverSummaryActivityState, heldReason: string) => {
      await publish({
        activityId, ownerUserId: prior.ownerUserId, gameId: prior.gameId,
        lapGuids: JSON.parse(prior.lapGuidsJson) as string[], payload: JSON.parse(prior.payloadJson),
        contentHash: prior.contentHash, expectedCloudRevision: prior.expectedCloudRevision, state, heldReason,
      });
    };
    try {
      if (!activityRows.length) { preparationHold = "Local original source is absent"; continue; }
      const ordered = [...activityRows].sort((a, b) => a.sessionId - b.sessionId || (a.lapId ?? 0) - (b.lapId ?? 0));
      const completeRows = ordered.filter((row) => representations.get(row.sessionId)?.proof);
      const canonical = completeRows[0] ?? ordered[0]!;
      const gameId = canonical.gameId;
      const originalOwnerId = canonical.ownerUserId;
      const prior = await getDriverSummaryActivity(activityId, originalOwnerId);
      if (!completeRows.length) {
        if (prior && prior.state !== "synced" && prior.state !== "conflict") {
          await retainWithState(prior, "held_ambiguous", preparationHold!);
        }
        continue;
      }
      snapshot.heldLaps = completeRows.filter((row) => row.lapId !== null && sourceAttribution(row) === "Unknown").length;
      preparationHold = null;
      const canonicalByGuid = new Map<string, SourceLap>();
      let duplicateFactsConflict = false;
      const checkedSessions = new Set<number>();
      let originalSessionFacts: string | null = null;
      let deduplicated = 0;
      for (const row of completeRows) {
        if (++deduplicated % 256 === 0) await yieldPreparation();
        if (!checkedSessions.has(row.sessionId)) {
          checkedSessions.add(row.sessionId);
          const sessionFacts = JSON.stringify([row.gameId, row.carId, row.trackId, row.sessionType, row.sessionStints, row.durationAttribution]);
          if (originalSessionFacts !== null && originalSessionFacts !== sessionFacts) duplicateFactsConflict = true;
          originalSessionFacts ??= sessionFacts;
        }
        if (!row.lapGuid) continue;
        const previous = canonicalByGuid.get(row.lapGuid);
        if (!previous) { canonicalByGuid.set(row.lapGuid, row); continue; }
        const previousFacts = JSON.stringify([previous.gameId, previous.carId, previous.trackId, previous.sessionType, previous.lapTime, previous.valid,
          previous.invalidReason, previous.lapStints, previous.sessionStints, previous.clockDomain, previous.lapStartMs, previous.lapEndMs, previous.trackLengthMeters, previous.durationAttribution]);
        const rowFacts = JSON.stringify([row.gameId, row.carId, row.trackId, row.sessionType, row.lapTime, row.valid,
          row.invalidReason, row.lapStints, row.sessionStints, row.clockDomain, row.lapStartMs, row.lapEndMs, row.trackLengthMeters, row.durationAttribution]);
        if (previousFacts !== rowFacts) duplicateFactsConflict = true;
      }
      const sourceRows = canonicalByGuid.size ? [...canonicalByGuid.values()] : [canonical];
      const personalRows = sourceRows.filter((row) => row.lapId !== null && sourceAttribution(row) === "Self");
      const uniqueGuids = personalRows.map((row) => row.lapGuid!).sort();
      const sourceGuidSet = new Set(sourceRows.flatMap((row) => row.lapGuid ? [row.lapGuid] : []));
      const sourceIdentityIncomplete = completeRows.some((row) => {
        const proof = representations.get(row.sessionId)!.proof!;
        return proof.originalLapGuids.length !== sourceGuidSet.size
          || proof.originalLapGuids.some((guid) => !sourceGuidSet.has(guid));
      }) || completeRows.some((row) => row.ownerUserId !== originalOwnerId);
      const overlapping = sourceRows.some((row) => row.lapGuid && ((guidOwners.get(row.lapGuid)?.size ?? 0) > 1
        || (priorByGuid.has(row.lapGuid) && priorByGuid.get(row.lapGuid) !== activityId)));
      const ownershipConflict = originalOwnerId !== null && originalOwnerId !== accountOwner;
      const unclaimedWithAccount = originalOwnerId === null && accountOwner !== null;
      const facts = await contributionMetrics(sourceRows);
      const ambiguous = !KNOWN_GAME_IDS.includes(gameId as GameId) || sourceRows.some((row) => row.gameId !== gameId)
        || sourceIdentityIncomplete || duplicateFactsConflict || overlapping || ownershipConflict || unclaimedWithAccount;
      const ledgerOwnerId = originalOwnerId;
      if (!uniqueGuids.length && facts.metrics.sessionsWithDuration === 0 && !prior) continue;
      if (overlapping || ownershipConflict || unclaimedWithAccount) {
        preparationHold = "Original GUID or immutable owner conflicts with existing contribution";
        snapshot.heldLaps = sourceRows.filter((row) => row.lapId !== null).length;
        if (prior) await retainWithState(prior, "conflict", preparationHold);
        continue;
      }
      const payloadBase: ActivityContributionHashPayload = {
        schemaVersion: 2, activityId, lapGuids: uniqueGuids, gameId, metrics: facts.metrics,
        cars: facts.cars, tracks: facts.tracks, coverage: {
          ...facts.coverage,
          identity: ambiguous ? "partial" : facts.coverage.identity,
        },
      };
      await yieldPreparation();
      const contentHash = await hash(payloadBase);
      if (!contentHash || !/^[0-9a-f]{64}$/i.test(contentHash)) throw new TypeError("Activity contribution hash provider returned an invalid SHA-256 digest");
      let expectedRevision = prior?.cloudRevision ?? prior?.heldCloudRevision ?? prior?.expectedCloudRevision ?? null;
      if (expectedRevision !== null) expectedRevision = Math.max(expectedRevision, prior?.heldCloudRevision ?? 0, prior?.expectedCloudRevision ?? 0);
      const heldReceipt = prior?.heldReceiptJson ? JSON.parse(prior.heldReceiptJson) as DriverSummaryCloudReceipt : null;
      const matchesHeld = heldReceipt?.contentHash === contentHash;
      const payload: ActivityContribution = { ...payloadBase, expectedRevision, contentHash };
      const unchanged = prior?.contentHash === contentHash;
      if (prior && unchanged) {
        const previous = JSON.parse(prior.payloadJson) as ActivityContribution;
        const { expectedRevision: _expectedRevision, contentHash: _contentHash, ...previousBody } = previous;
        if (await hash(previousBody) !== contentHash) {
          throw Object.assign(new Error("Stored contribution does not match its canonical hash"), { code: "activity_hash_conflict" });
        }
        if (prior.state === "synced" || prior.state === "conflict" || matchesHeld) {
          snapshot.contentHash = contentHash; snapshot.payload = payloadBase;
          preparationHold = ambiguous ? "Original source identity or GUID coverage is ambiguous" : null;
          continue;
        }
      }
      const state: DriverSummaryActivityState = prior?.state === "conflict" ? "conflict" : ambiguous || matchesHeld ? "held_ambiguous" : "ready";
      const heldReason = state === "conflict" ? prior!.heldReason
        : ambiguous ? "Original source identity or GUID coverage is ambiguous" : matchesHeld ? prior?.heldReason ?? null : null;
      const input: DriverSummaryActivityInput = {
        activityId, ownerUserId: ledgerOwnerId, gameId, lapGuids: uniqueGuids, payload, contentHash,
        expectedCloudRevision: expectedRevision, state, heldReason,
      };
      snapshot.contentHash = contentHash; snapshot.payload = payloadBase;
      preparationHold = ambiguous ? "Original source identity or GUID coverage is ambiguous" : null;
      if (ambiguous) snapshot.heldLaps = sourceRows.filter((row) => row.lapId !== null).length;
      await publish(input);
      if (!matchesHeld) results.push(input);
    } catch (error) {
      failed = true;
      if (error && typeof error === "object" && "code" in error && error.code === "stale_source") {
        results.splice(resultStart);
        continue;
      }
      throw error;
    } finally {
      // A concurrent source mutation leaves the durable generation dirty. Never return stale preparation.
      if (!failed && !published && !await settleDriverSummaryPreparation(source, snapshot, preparationHold)) results.splice(resultStart);
    }
  }
  return results;
}

export interface DriverSummaryCloudReceipt { activityId: string; revision: number; contentHash: string; onlineRevision?: number; syncedAt?: string }

export interface DriverSummaryHeldView {
  receipt: DriverSummaryCloudReceipt;
  contribution: DriverSummaryActivityContribution;
  status: "held";
  holdReason: string | null;
}
export interface DriverSummaryHoldSource { ownerUserId: string; hash: ActivityContributionHash }

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function nonnegativeInteger(value: unknown): value is number {
  return finiteNonnegative(value) && Number.isSafeInteger(value);
}

/** Check the canonical v2 boundary before asking the SDK to hash an owner readback. */
function validateContribution(value: ActivityContribution): void {
  const invalid = () => Object.assign(new Error("Owner readback contribution is malformed"), { code: "activity_revision_conflict" });
  if (!value || typeof value !== "object" || value.schemaVersion !== 2 || typeof value.activityId !== "string" || !value.activityId.trim()
    || typeof value.gameId !== "string" || !KNOWN_GAME_IDS.includes(value.gameId as GameId)
    || typeof value.contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(value.contentHash)
    || (value.expectedRevision !== null && !nonnegativeInteger(value.expectedRevision))
    || !Array.isArray(value.lapGuids) || value.lapGuids.some((guid) => typeof guid !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guid))
    || new Set(value.lapGuids).size !== value.lapGuids.length) throw invalid();
  const metrics = value.metrics, coverage = value.coverage;
  if (!metrics || typeof metrics !== "object" || !metrics.sessionTypeSeconds || typeof metrics.sessionTypeSeconds !== "object"
    || !coverage || typeof coverage !== "object"
    || !nonnegativeInteger(metrics.laps) || !nonnegativeInteger(metrics.positiveLaps) || !nonnegativeInteger(metrics.validLaps)
    || !nonnegativeInteger(metrics.sessionsWithDuration) || !nonnegativeInteger(metrics.sessionsWithoutDuration)
    || !finiteNonnegative(metrics.drivenSeconds) || !finiteNonnegative(metrics.validSeconds)
    || metrics.validSeconds > metrics.drivenSeconds || metrics.validLaps > metrics.positiveLaps
    || metrics.positiveLaps > metrics.laps || metrics.laps !== value.lapGuids.length
    || (metrics.distanceMeters !== null && !finiteNonnegative(metrics.distanceMeters))
    || !["practice", "qualifying", "race", "unknown"].every((key) => finiteNonnegative(metrics.sessionTypeSeconds[key as keyof MetricTotals["sessionTypeSeconds"]]))
    || !["complete", "partial"].includes(coverage.identity)
    || !["complete", "partial"].includes(coverage.driverAttribution)
    || !["complete", "partial", "unavailable"].includes(coverage.sessionDuration)
    || !["complete", "partial", "unavailable"].includes(coverage.distance)) throw invalid();
  for (const entities of [value.cars, value.tracks]) {
    if (!Array.isArray(entities)) throw invalid();
    const identities = new Set<string>();
    for (const entity of entities) {
      if (!entity || typeof entity !== "object" || entity.gameId !== value.gameId || typeof entity.nativeId !== "string" || !entity.nativeId.trim()
        || !nonnegativeInteger(entity.laps) || !finiteNonnegative(entity.seconds) || identities.has(entity.nativeId)) throw invalid();
      identities.add(entity.nativeId);
    }
  }
}

/** A held readback advances only the cloud baseline, never confirmed acceptance or the local pending body. */
export async function recordDriverSummaryHold(view: DriverSummaryHeldView, source: DriverSummaryHoldSource): Promise<void> {
  const ownerUserId = await getLocalAccountOwner();
  if (!ownerUserId || !source || source.ownerUserId !== ownerUserId) {
    throw Object.assign(new Error("Held owner readback is not authenticated for this installation"), { code: "activity_owner_conflict" });
  }
  if (!view || view.status !== "held" || !view.receipt || !Number.isSafeInteger(view.receipt.revision) || view.receipt.revision < 0
    || typeof view.receipt.activityId !== "string" || !view.receipt.activityId.trim()
    || typeof view.receipt.contentHash !== "string" || !/^[0-9a-f]{64}$/i.test(view.receipt.contentHash)
    || (view.holdReason !== null && typeof view.holdReason !== "string") || typeof source.hash !== "function") {
    throw Object.assign(new Error("Invalid held driver summary receipt"), { code: "activity_revision_conflict" });
  }
  validateContribution(view.contribution);
  const { receipt, contribution } = view;
  const existing = await getDriverSummaryActivity(receipt.activityId, ownerUserId);
  if (!existing) throw Object.assign(new Error("Driver summary activity not found"), { code: "not_found" });
  const pending = JSON.parse(existing.payloadJson) as ActivityContribution;
  validateContribution(pending);
  const { expectedRevision: _revision, contentHash, ...body } = contribution;
  const { expectedRevision: _pendingRevision, contentHash: pendingHash, ...pendingBody } = pending;
  if (contribution.activityId !== receipt.activityId || contribution.gameId !== existing.gameId || contentHash !== receipt.contentHash
    || pending.activityId !== receipt.activityId || pending.gameId !== existing.gameId || pendingHash !== existing.contentHash
    || await source.hash(body) !== receipt.contentHash || await source.hash(pendingBody) !== existing.contentHash) {
    throw Object.assign(new Error("Held receipt does not match canonical original content"), { code: "activity_revision_conflict" });
  }
  await recordDriverSummaryActivityHold({
    activityId: receipt.activityId, ownerUserId, receipt, lapGuids: contribution.lapGuids,
    observedContentHash: existing.contentHash, observedPayloadJson: existing.payloadJson, holdReason: view.holdReason,
  });
}
export type DriverSummaryReceiptSource = { source: "owner_readback"; ownerUserId: string; status: "confirmed"; contribution: DriverSummaryActivityContribution; hash: ActivityContributionHash };
export async function recordDriverSummaryReceipt(
  receipt: DriverSummaryCloudReceipt,
  source: DriverSummaryReceiptSource,
): Promise<void> {
  if (!receipt.activityId?.trim() || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || !/^[0-9a-f]{64}$/i.test(receipt.contentHash)) {
    throw new RangeError("Invalid driver summary receipt");
  }
  const ownerUserId = await getLocalAccountOwner();
  if (!ownerUserId || !source || source.source !== "owner_readback" || source.ownerUserId !== ownerUserId
    || source.status !== "confirmed" || typeof source.hash !== "function") {
    throw Object.assign(new Error("Receipt owner readback is not authenticated for this installation"), { code: "activity_owner_conflict" });
  }
  const existing = await getDriverSummaryActivity(receipt.activityId, ownerUserId);
  if (!existing) throw Object.assign(new Error("Driver summary activity not found"), { code: "not_found" });
  const minimumRevision = Math.max(existing.cloudRevision ?? 0, existing.heldCloudRevision ?? 0, existing.expectedCloudRevision ?? 0);
  if (receipt.revision < minimumRevision) {
    throw Object.assign(new Error("Contribution receipt is stale"), { code: "activity_revision_conflict" });
  }
  validateContribution(source.contribution);
  const stored = JSON.parse(existing.payloadJson) as ActivityContribution;
  validateContribution(stored);
  const { expectedRevision: _expectedRevision, contentHash: bodyHash, ...body } = source.contribution;
  const { expectedRevision: _storedRevision, contentHash: storedHash, ...storedBody } = stored;
  if (source.contribution.activityId !== receipt.activityId || source.contribution.gameId !== existing.gameId
    || stored.activityId !== receipt.activityId || stored.gameId !== existing.gameId || storedHash !== existing.contentHash
    || bodyHash !== receipt.contentHash || await source.hash(body) !== receipt.contentHash
    || await source.hash(storedBody) !== existing.contentHash) {
    throw Object.assign(new Error("Owner readback does not match canonical original content"), { code: "activity_revision_conflict" });
  }
  await recordDriverSummaryActivityConfirmation({
    activityId: receipt.activityId, ownerUserId, gameId: source.contribution.gameId, receipt,
    lapGuids: source.contribution.lapGuids, observedContentHash: existing.contentHash, observedPayloadJson: existing.payloadJson,
  });
}

export async function listDriverSummaryContributions(): Promise<DriverSummaryContributionRecord[]> {
  return listDriverSummaryActivities(await getLocalAccountOwner());
}

export async function listReadyDriverSummaryContributionPage(
  afterId: string | null = null, limit = 64,
): Promise<{ items: DriverSummaryContributionRecord[]; nextCursor: string | null }> {
  return listReadyDriverSummaryActivityPage(await getLocalAccountOwner(), afterId, limit);
}
