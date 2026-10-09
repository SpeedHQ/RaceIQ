import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getTrackLengthMeters } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import type { GameId } from "@raceiq/shared/games/ids";
import { TrackConditionsAccumulator, type TrackConditions } from "../ai/track-conditions";
import { getServerGame } from "../games/registry";
import { dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import { client } from "../db/index";
import {
  DASHBOARD_PROCESSOR_VERSION,
  prepareDashboardPublicationCandidate,
  publishDashboardSession,
  type DashboardCaptureFacts,
  type DashboardPublicationCandidate,
} from "../db/dashboard-summary-queries";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "./source-loader";

const USES_SESSION_CLOCK: Partial<Record<GameId, true>> = { "fm-2023": true, "f1-2025": true, iracing: true, lmu: true };
const BATCH_SIZE = 25;
const checkpointYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type SessionInfo = { raw_file: string | null; source: string | null; game_id: string; car_ordinal: number; track_ordinal: number; track_id: string | number | null };


function unavailableCapture(candidate: DashboardPublicationCandidate): DashboardCaptureFacts {
  return { sourceRevision: candidate.sourceRevision, captureRevision: "missing", duration: { status: "unavailable", elapsedSeconds: null }, sectorLayout: null, weather: { status: "unavailable", revision: null, conditions: null }, trackLengthMeters: null, sourceSectorStarts: null };
}

export type ObservedDashboardCaptureFacts = Omit<DashboardCaptureFacts, "sourceRevision">;

/** Publish facts gathered during the authoritative packet-processing pass. */
export async function publishObservedDashboardCaptureFacts(
  sessionId: number,
  facts: ObservedDashboardCaptureFacts,
): Promise<boolean> {
  const candidate = await prepareDashboardPublicationCandidate(sessionId);
  if (!candidate || candidate.deleted || !candidate.captureDirty) return false;
  return publishDashboardSession(candidate, { ...facts, sourceRevision: candidate.sourceRevision });
}
function persistedTrackConditions(value: unknown): value is TrackConditions {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const numeric = (key: string): boolean => typeof row[key] === "number" && Number.isFinite(row[key]);
  const range = (key: string): boolean => {
    const item = row[key];
    if (item === null) return true;
    if (typeof item !== "object" || item === null) return false;
    const stats = item as Record<string, unknown>;
    return ["min", "max", "avg"].every((name) => typeof stats[name] === "number" && Number.isFinite(stats[name]));
  };
  return numeric("frames") && numeric("rainIntensity") && typeof row.wet === "boolean"
    && typeof row.trackGripStatus === "string" && numeric("windSpeedKmh") && numeric("windDirectionDeg")
    && range("airTempC") && range("roadTempC")
    && (row.startingGrip === null || typeof row.startingGrip === "string")
    && (row.staticWeather === null || typeof row.staticWeather === "boolean");
}

function persistedStarts(value: unknown): number[] | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((start) => typeof start === "number" && Number.isFinite(start))
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Re-anchor unchanged persisted capture evidence after a lossless file lifecycle mutation. */
export async function republishPersistedDashboardCaptureFacts(sessionIds: readonly number[]): Promise<boolean> {
  for (const sessionId of sessionIds) {
    const candidate = await prepareDashboardPublicationCandidate(sessionId);
    if (!candidate || !candidate.captureDirty || candidate.deleted || !candidate.session || !candidate.session.raw_file
      || candidate.sourceRevision !== candidate.publishedRevision + 1) return false;
    const result = await client.execute({ sql: "SELECT * FROM dashboard_session_summaries WHERE session_id=?", args: [sessionId] });
    const row = result.rows[0];
    if (!row) return false;
    const durationStatus = row.duration_status === "available" || row.duration_status === "unavailable" ? row.duration_status : null;
    const sectorStatus = row.sector_status === "available" || row.sector_status === "unavailable" ? row.sector_status : null;
    const weatherStatus = row.weather_status === "available" || row.weather_status === "unavailable" ? row.weather_status : null;
    if (Number(row.source_revision) !== candidate.publishedRevision
      || typeof row.capture_revision !== "string" || !row.capture_revision
      || !durationStatus || !sectorStatus || !weatherStatus) return false;
    const starts = persistedStarts(row.source_sector_starts_json);
    if (starts === undefined) return false;
    const conditionsJson = row.weather_conditions_json;
    let conditions: TrackConditions | null = null;
    if (weatherStatus === "available") {
      if (typeof conditionsJson !== "string") return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(conditionsJson);
      } catch {
        return false;
      }
      if (!persistedTrackConditions(parsed)) return false;
      conditions = parsed;
    } else if (conditionsJson !== null) return false;
    const sectorLayout = sectorStatus === "available"
      ? typeof row.sector_layout_key === "string" && Number(row.sector_count) > 0 && starts !== null
        && starts.length === Number(row.sector_count)
        ? { status: "available" as const, key: row.sector_layout_key, sectorCount: Number(row.sector_count), starts }
        : null
      : null;
    if (sectorStatus === "available" && sectorLayout === null) return false;
    const elapsedSeconds = durationStatus === "available" ? Number(row.elapsed_seconds) : null;
    if (elapsedSeconds !== null && (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)) return false;
    const trackLength = row.track_length_meters === null ? null : Number(row.track_length_meters);
    if (trackLength !== null && (!Number.isFinite(trackLength) || trackLength <= 0)) return false;
    const evidence: DashboardCaptureFacts = {
      sourceRevision: candidate.sourceRevision,
      captureRevision: row.capture_revision,
      duration: { status: durationStatus, elapsedSeconds },
      sectorLayout,
      weather: {
        status: weatherStatus,
        revision: typeof row.weather_revision === "string" ? row.weather_revision : null,
        conditions,
      },
      trackLengthMeters: trackLength,
      sourceSectorStarts: starts,
    };
    if (!await publishDashboardSession(candidate, evidence)) return false;
  }
  return true;
}

async function readCaptureFacts(candidate: DashboardPublicationCandidate): Promise<DashboardCaptureFacts> {
  const session = candidate.session as SessionInfo | null;
  if (!session?.raw_file) return unavailableCapture(candidate);
  const source: SessionCaptureSource = { rawFile: session.raw_file, source: session.source, gameId: session.game_id as GameId, carOrdinal: session.car_ordinal, trackOrdinal: session.track_ordinal };
  const initialStat = await stat(source.rawFile).catch(() => null);
  if (!initialStat) return unavailableCapture(candidate);
  const game = getServerGame(source.gameId);
  const useClock = USES_SESSION_CLOCK[source.gameId] === true;
  let parserState = game.createParserState();
  let segmentDomain: "utc" | "simulator" | null = null;
  let segmentMin = Infinity;
  let segmentMax = -Infinity;
  let segmentLast = -Infinity;
  let elapsedSeconds = 0;
  let timingKnown = true;
  let hasTiming = false;
  let layout: { starts: number[]; trackLengthM?: number } | null = null;
  const weather = new TrackConditionsAccumulator();
  let packetCount = 0;
  const finishSegment = () => {
    if (segmentMin !== Infinity) elapsedSeconds += (segmentMax - segmentMin) / (segmentDomain === "utc" ? 1000 : 1);
    segmentDomain = null; segmentMin = Infinity; segmentMax = -Infinity; segmentLast = -Infinity;
  };
  const addTime = (value: number, domain: "utc" | "simulator") => {
    if (!Number.isFinite(value) || (segmentDomain !== null && segmentDomain !== domain) || value < segmentLast) { timingKnown = false; return; }
    hasTiming = true; segmentDomain = domain; segmentLast = value; segmentMin = Math.min(segmentMin, value); segmentMax = Math.max(segmentMax, value);
  };
  const captureHasher = createHash("sha256");
  for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
    captureHasher.update(record.kind);
    if (record.kind === "frame") {
      captureHasher.update(record.frame);
      captureHasher.update(String(record.frameTimeMs ?? ""));
    }
    if (record.kind === "segment-boundary") { finishSegment(); parserState = game.createParserState(); continue; }
    if (record.kind === "segment-context") continue;
    if (record.kind === "segment-context-end") continue;
    if (record.kind !== "frame") continue;
    const packet = game.tryParse(record.frame, parserState);
    if (!packet) continue;
    packetCount++;
    if (record.frameTimeMs !== undefined) addTime(record.frameTimeMs, "utc");
    else if (useClock) {
      const useUtc = source.gameId === "lmu" && Number.isFinite(packet.TimestampMS) && packet.TimestampMS >= 0;
      const value = useUtc ? packet.TimestampMS! : packet.CurrentRaceTime;
      if (Number.isFinite(value) && value! >= 0) addTime(value!, useUtc ? "utc" : "simulator");
      else timingKnown = false;
    } else timingKnown = false;
    weather.add(packet);
    if (!layout && game.getNativeSectorLayout) {
      const found = game.getNativeSectorLayout(packet);
      if (found && found.starts.length >= 2 && found.starts.length <= 16 && found.starts.every((start) => Number.isFinite(start) && start >= 0 && start < 1)) layout = { starts: [...found.starts], trackLengthM: found.trackLengthM };
    }
  }
  const fingerprint = captureHasher.digest("hex");
  finishSegment();
  if (!packetCount) timingKnown = false;
  const weatherConditions = weather.result();
  const finalStat = await stat(source.rawFile).catch(() => null);
  if (!finalStat || finalStat.size !== initialStat.size || finalStat.mtimeMs !== initialStat.mtimeMs) throw new Error("Capture changed during dashboard processing");
  const revision = `${fingerprint}:${DASHBOARD_PROCESSOR_VERSION}`;
  const trackLengthMeters = layout?.trackLengthM ?? getTrackLengthMeters(source.trackOrdinal, source.gameId);
  const trackKey = dashboardTrackIdentity(source.gameId, session.track_id, source.trackOrdinal);
  const sectorLayout = layout && layout.starts.length <= 16
    ? { status: "available" as const, key: `${trackKey}:${layout.starts.join(",")}`, sectorCount: layout.starts.length, starts: layout.starts }
    : null;
  const weatherRevision = weatherConditions ? createHash("sha256").update(JSON.stringify(weatherConditions)).digest("hex") : null;
  return {
    sourceRevision: candidate.sourceRevision,
    captureRevision: revision,
    duration: { status: timingKnown && hasTiming ? "available" : "unavailable", elapsedSeconds: timingKnown && hasTiming ? elapsedSeconds : null },
    sectorLayout,
    weather: { status: weatherConditions ? "available" : "unavailable", revision: weatherRevision, conditions: weatherConditions },
    trackLengthMeters: Number.isFinite(trackLengthMeters) && trackLengthMeters! > 0 ? trackLengthMeters! : null,
    sourceSectorStarts: layout?.starts ?? null,
  };
}

async function selectNextSession(lastSessionId: number): Promise<number | null> {
  const result = await client.execute({ sql: `SELECT s.id FROM sessions s LEFT JOIN dashboard_summary_state st ON st.session_id=s.id
    LEFT JOIN dashboard_session_summaries p ON p.session_id=s.id
    WHERE s.ownership='mine' AND s.id>? AND (st.session_id IS NULL OR ((st.processor_version!=? OR st.metadata_dirty=1 OR (st.capture_dirty=1 AND st.capture_ready=1) OR p.session_id IS NULL OR (st.published_revision!=st.source_revision AND (st.capture_dirty=0 OR st.capture_ready=1))) AND (st.next_retry_at IS NULL OR st.next_retry_at<=datetime('now'))))
    ORDER BY s.id LIMIT 1`, args: [lastSessionId, DASHBOARD_PROCESSOR_VERSION] });
  return result.rows.length ? Number((result.rows[0] as Record<string, unknown>).id) : null;
}

async function rememberBackfillCursor(id: number): Promise<void> {
  await client.execute({ sql: `UPDATE dashboard_backfill_cursor SET last_session_id=?,updated_at=datetime('now') WHERE id=1`, args: [id] });
}

async function resetBackfillCursor(): Promise<void> {
  await client.execute({ sql: `UPDATE dashboard_backfill_cursor SET last_session_id=0,updated_at=datetime('now') WHERE id=1` });
}

export async function processDashboardSession(id: number): Promise<boolean> {
  let candidate = await prepareDashboardPublicationCandidate(id);
  if (!candidate) return false;
  if (candidate.deleted || !candidate.session) return publishDashboardSession(candidate);
  if (candidate.metadataDirty || candidate.publishedRevision !== candidate.sourceRevision) {
    if (!await publishDashboardSession(candidate, undefined, { metadataOnly: true })) return false;
    candidate = await prepareDashboardPublicationCandidate(id);
    if (!candidate) return false;
  }
  if (!candidate.captureDirty || !candidate.captureReady) return true;
  const evidence = await readCaptureFacts(candidate);
  const afterRead = await prepareDashboardPublicationCandidate(id);
  if (!afterRead || afterRead.sourceRevision !== evidence.sourceRevision || !afterRead.captureReady) return false;
  return publishDashboardSession(afterRead, evidence);
}

export type DashboardCheckpointExecutor = Pick<typeof client, "execute">;

export async function markDashboardCaptureCheckpoint(
  sessionId: number,
  finalized = false,
  executor: DashboardCheckpointExecutor = client,
): Promise<void> {
  await executor.execute({ sql: `INSERT INTO dashboard_summary_state(session_id,source_revision,capture_dirty,metadata_dirty,capture_ready)
    SELECT s.id,1,1,0,? FROM sessions s
    WHERE s.ownership='mine' AND (s.id=? OR s.raw_file=(SELECT raw_file FROM sessions WHERE id=? AND raw_file IS NOT NULL))
    ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,capture_dirty=1,capture_ready=excluded.capture_ready,updated_at=datetime('now')`,
    args: [finalized ? 1 : 0, sessionId, sessionId] });
}
export async function releaseDashboardCaptureCheckpoint(sessionId: number): Promise<void> {
  await client.execute({ sql: `UPDATE dashboard_summary_state SET capture_ready=1,updated_at=datetime('now')
    WHERE session_id=? AND capture_dirty=1 AND deleted=0`, args: [sessionId] });
}
async function recordProcessingFailure(sessionId: number): Promise<void> {
  await client.execute({ sql: `UPDATE dashboard_summary_state SET retry_count=retry_count+1,
    next_retry_at=datetime('now','+' || MIN(300, (1 << MIN(retry_count, 8))) || ' seconds'),
    last_error_code='dashboard_processing_failed',updated_at=datetime('now') WHERE session_id=?`, args: [sessionId] });
}

export interface DashboardProcessorHandle { stop(): Promise<void>; }

export function startDashboardProcessor(options: { signal?: AbortSignal; idleMs?: number } = {}): DashboardProcessorHandle {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  let stopped = false;
  const run = async () => {
    const cursorRow = await client.execute({ sql: "SELECT last_session_id FROM dashboard_backfill_cursor WHERE id=1" });
    let cursor = Number((cursorRow.rows[0] as Record<string, unknown> | undefined)?.last_session_id ?? 0);
    let visited = 0;
    let workSessionId: number | null = null;
    while (!stopped && !signal.aborted) {
      try {
        let id = await selectNextSession(cursor);
        if (id === null) {
          if (cursor !== 0) { await resetBackfillCursor(); cursor = 0; visited = 0; }
          const queued = await client.execute({ sql: `SELECT session_id FROM dashboard_summary_state
            WHERE (metadata_dirty=1 OR (capture_dirty=1 AND capture_ready=1) OR (published_revision!=source_revision AND (capture_dirty=0 OR capture_ready=1)))
              AND (next_retry_at IS NULL OR next_retry_at<=datetime('now')) ORDER BY session_id LIMIT 1` });
          if (queued.rows.length) id = Number((queued.rows[0] as Record<string, unknown>).session_id);
          else { await new Promise((resolve) => setTimeout(resolve, options.idleMs ?? 1000)); continue; }
        }
        workSessionId = id;
        cursor = id;
        await rememberBackfillCursor(id);
        await processDashboardSession(id);
        workSessionId = null;
        visited++;
        if (visited % BATCH_SIZE === 0) await checkpointYield();
      } catch (error) {
        console.error("[DashboardProcessor] Session processing failed:", error);
        if (workSessionId !== null) {
          await recordProcessingFailure(workSessionId).catch((recordError) => console.error("[DashboardProcessor] Failed to persist retry state:", recordError));
          workSessionId = null;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * Math.max(1, visited))));
      }
    }
  };
  const done = run();
  return { async stop() { if (stopped) return; stopped = true; if (!options.signal) controller.abort(); await done; } };
}
