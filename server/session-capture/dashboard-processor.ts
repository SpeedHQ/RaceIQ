import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { GameId } from "@raceiq/shared/games/ids";
import type { TrackConditions } from "../ai/track-conditions";
import { getServerGame } from "../games/registry";
import { client, readClient } from "../db/index";
import {
  DASHBOARD_PROCESSOR_VERSION,
  prepareDashboardPublicationCandidate,
  publishDashboardSession,
  type DashboardCaptureFacts,
  type DashboardPublicationCandidate,
  type DashboardPublicationHooks,
} from "../db/dashboard-summary-queries";
import { withDatabaseWrite } from "../db/write-coordination";
import { PARSER_BOOTSTRAP_VERSION } from "@raceiq/capture-formats/session/framing";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "./source-loader";
import { DashboardCaptureObservation } from "./dashboard-observation";
import { dashboardStints, dashboardDurationAttribution } from "../driver-summary/dashboard-input";
import { getNativeSourceClock } from "../lap-detection/native-attribution";
import { readVerifiedPortableOriginalDuration } from "../db/original-activity-queries";
import { hasTerminalMigrationCaptureFailure } from "./classification-migration";

const BATCH_SIZE = 25;
const checkpointYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
type SessionInfo = { raw_file: string | null; source: string | null; game_id: string; car_id: string | null; track_id: string | null; capture_format_version: number | null; driver_attribution_stints: unknown };


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
  return publishDashboardSession(candidate, await withVerifiedOriginalDuration(sessionId, { ...facts, sourceRevision: candidate.sourceRevision }));
}

async function withVerifiedOriginalDuration(sessionId: number, facts: DashboardCaptureFacts): Promise<DashboardCaptureFacts> {
  const duration = await readVerifiedPortableOriginalDuration(sessionId);
  return duration ? { ...facts, duration } : facts;
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
    const result = await readClient.execute({ sql: "SELECT * FROM dashboard_session_summaries WHERE session_id=?", args: [sessionId] });
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
      duration: { status: durationStatus, elapsedSeconds, attribution: dashboardDurationAttribution(row.duration_attribution_json) },
      sectorLayout,
      weather: {
        status: weatherStatus,
        revision: typeof row.weather_revision === "string" ? row.weather_revision : null,
        conditions,
      },
      trackLengthMeters: trackLength,
      sourceSectorStarts: starts,
    };
    if (!await publishDashboardSession(candidate, await withVerifiedOriginalDuration(sessionId, evidence))) return false;
  }
  return true;
}

async function readCaptureFacts(candidate: DashboardPublicationCandidate): Promise<DashboardCaptureFacts> {
  const session = candidate.session as SessionInfo | null;
  if (!session?.raw_file) return unavailableCapture(candidate);
  const source: SessionCaptureSource = { rawFile: session.raw_file, source: session.source, gameId: session.game_id as GameId, carId: session.car_id ?? "", trackId: session.track_id ?? "", captureFormatVersion: session.capture_format_version };
  const initialStat = await stat(source.rawFile).catch(() => null);
  if (!initialStat) return unavailableCapture(candidate);
  const game = getServerGame(source.gameId);
  let parserState = game.createParserState();
  const observation = new DashboardCaptureObservation(source.gameId, source.trackId);
  const stints = dashboardStints(session.driver_attribution_stints);
  const captureHasher = createHash("sha256");
  let inContext = false;
  try {
  for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true, allowLegacyFullFrames: true })) {
    captureHasher.update(record.kind);
    if (record.kind === "frame") {
      captureHasher.update(record.frame);
      captureHasher.update(String(record.frameTimeMs ?? ""));
    }
    if (record.kind === "parser-bootstrap") {
      captureHasher.update(record.gameId);
      captureHasher.update(String(record.formatVersion));
      captureHasher.update(record.payload);
    }
    if (record.kind === "segment-boundary") {
      observation.finishSegment(); parserState = game.createParserState(); continue;
    }
    if (record.kind === "segment-context") { inContext = true; observation.finishSegment(); continue; }
    if (record.kind === "segment-context-end") { inContext = false; observation.finishSegment(); continue; }
    if (record.kind === "parser-bootstrap") {
      if (record.gameId !== source.gameId || record.formatVersion !== PARSER_BOOTSTRAP_VERSION) {
        throw new Error("Parser bootstrap does not match dashboard source");
      }
      if (!game.restoreParserCheckpoint) {
        throw new Error(`Parser checkpoint restore unavailable for ${source.gameId}`);
      }
      parserState = game.restoreParserCheckpoint(parserState, record.payload);
      continue;
    }
    if (record.kind !== "frame") continue;
    const packet = game.tryParse(record.frame, parserState);
    if (!packet) continue;
    if (inContext) continue;
    const clock = getNativeSourceClock(packet, record.frameTimeMs);
    observation.observe(packet, record.frame, record.frameTimeMs,
      clock ? { sessionId: clock.sessionId, clockDomain: clock.domain, sourceTimeMs: clock.atMs, stints } : undefined);
  }
  } catch (error) {
    if (await hasTerminalMigrationCaptureFailure(candidate.sessionId)) return unavailableCapture(candidate);
    throw error;
  }
  const fingerprint = captureHasher.digest("hex");
  const finalStat = await stat(source.rawFile).catch(() => null);
  if (!finalStat || finalStat.size !== initialStat.size || finalStat.mtimeMs !== initialStat.mtimeMs) throw new Error("Capture changed during dashboard processing");
  return { ...observation.toFacts(), sourceRevision: candidate.sourceRevision,
    captureRevision: `${fingerprint}:${DASHBOARD_PROCESSOR_VERSION}` };
}

async function selectNextSession(lastSessionId: number): Promise<number | null> {
  const result = await readClient.execute({ sql: `SELECT s.id FROM sessions s LEFT JOIN dashboard_summary_state st ON st.session_id=s.id
    LEFT JOIN dashboard_session_summaries p ON p.session_id=s.id
    WHERE s.ownership='mine' AND s.id>? AND (st.session_id IS NULL OR ((st.processor_version!=? OR st.metadata_dirty=1 OR (st.capture_dirty=1 AND st.capture_ready=1) OR p.session_id IS NULL OR (st.published_revision!=st.source_revision AND (st.capture_dirty=0 OR st.capture_ready=1))) AND (st.next_retry_at IS NULL OR st.next_retry_at<=datetime('now'))))
    ORDER BY s.id LIMIT 1`, args: [lastSessionId, DASHBOARD_PROCESSOR_VERSION] });
  return result.rows.length ? Number((result.rows[0] as Record<string, unknown>).id) : null;
}

async function rememberBackfillCursor(id: number, signal?: AbortSignal): Promise<void> {
  await withDatabaseWrite(() => client.execute({ sql: `UPDATE dashboard_backfill_cursor SET last_session_id=?,updated_at=datetime('now') WHERE id=1`, args: [id] }), signal);
}

async function resetBackfillCursor(signal?: AbortSignal): Promise<void> {
  await withDatabaseWrite(() => client.execute({ sql: `UPDATE dashboard_backfill_cursor SET last_session_id=0,updated_at=datetime('now') WHERE id=1` }), signal);
}

export async function processDashboardSession(id: number, hooks: DashboardPublicationHooks = {}): Promise<boolean> {
  let candidate = await prepareDashboardPublicationCandidate(id);
  if (!candidate) return false;
  if (candidate.deleted || !candidate.session) return publishDashboardSession(candidate, undefined, {}, hooks);
  if (candidate.metadataDirty || candidate.publishedRevision !== candidate.sourceRevision) {
    if (!await publishDashboardSession(candidate, undefined, { metadataOnly: true }, hooks)) return false;
    candidate = await prepareDashboardPublicationCandidate(id);
    if (!candidate) return false;
  }
  if (!candidate.captureDirty || !candidate.captureReady) return true;
  const evidence = await withVerifiedOriginalDuration(id, await readCaptureFacts(candidate));
  const afterRead = await prepareDashboardPublicationCandidate(id);
  if (!afterRead || afterRead.sourceRevision !== evidence.sourceRevision || !afterRead.captureReady
    || afterRead.publicationBaseline !== candidate.publicationBaseline) return false;
  return publishDashboardSession(afterRead, evidence, {}, hooks);
}

export type DashboardCheckpointExecutor = Pick<typeof client, "execute">;

export async function markDashboardCaptureCheckpoint(
  sessionId: number,
  finalized = false,
  executor: DashboardCheckpointExecutor = client,
): Promise<void> {
  await withDatabaseWrite(() => executor.execute({ sql: `INSERT INTO dashboard_summary_state(session_id,source_revision,capture_dirty,metadata_dirty,capture_ready)
    SELECT s.id,1,1,0,? FROM sessions s
    WHERE s.ownership='mine' AND (s.id=? OR s.raw_file=(SELECT raw_file FROM sessions WHERE id=? AND raw_file IS NOT NULL))
    ON CONFLICT(session_id) DO UPDATE SET source_revision=source_revision+1,capture_dirty=1,capture_ready=excluded.capture_ready,updated_at=datetime('now')`,
    args: [finalized ? 1 : 0, sessionId, sessionId] }));
}
export async function releaseDashboardCaptureCheckpoint(sessionId: number): Promise<void> {
  await withDatabaseWrite(() => client.execute({ sql: `UPDATE dashboard_summary_state SET capture_ready=1,updated_at=datetime('now')
    WHERE session_id=? AND capture_dirty=1 AND deleted=0`, args: [sessionId] }));
}
async function recordProcessingFailure(sessionId: number, signal?: AbortSignal): Promise<void> {
  await withDatabaseWrite(() => client.execute({ sql: `UPDATE dashboard_summary_state SET retry_count=retry_count+1,
    next_retry_at=datetime('now','+' || MIN(300, (1 << MIN(retry_count, 8))) || ' seconds'),
    last_error_code='dashboard_processing_failed',updated_at=datetime('now') WHERE session_id=?`, args: [sessionId] }), signal);
}
async function waitForClassificationAggregateTestBarrier(signal: AbortSignal): Promise<void> {
  if (process.env.RACEIQ_E2E !== "1" ||
    process.env.RACEIQ_CLASSIFICATION_TEST_BARRIER !== "afterCommitBeforeAggregates") return;
  const dir = process.env.RACEIQ_CLASSIFICATION_TEST_BARRIER_DIR;
  if (!dir) return;
  while (!signal.aborted) {
    try {
      await access(join(dir, "afterCommitBeforeAggregates.release"));
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

export interface DashboardProcessorHandle { stop(): Promise<void>; }

export function startDashboardProcessor(options: { signal?: AbortSignal; idleMs?: number; publicationHooks?: DashboardPublicationHooks } = {}): DashboardProcessorHandle {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  const wait = (milliseconds: number) => new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
  const run = async () => {
    const cursorRow = await readClient.execute({ sql: "SELECT last_session_id FROM dashboard_backfill_cursor WHERE id=1" });
    let cursor = Number((cursorRow.rows[0] as Record<string, unknown> | undefined)?.last_session_id ?? 0);
    let visited = 0;
    let workSessionId: number | null = null;
    while (!stopped && !signal.aborted) {
      await waitForClassificationAggregateTestBarrier(signal);
      try {
        let id = await selectNextSession(cursor);
        if (id === null) {
          if (cursor !== 0) { await resetBackfillCursor(signal); cursor = 0; visited = 0; }
          const queued = await readClient.execute({ sql: `SELECT session_id FROM dashboard_summary_state
            WHERE (metadata_dirty=1 OR (capture_dirty=1 AND capture_ready=1) OR (published_revision!=source_revision AND (capture_dirty=0 OR capture_ready=1)))
              AND (next_retry_at IS NULL OR next_retry_at<=datetime('now')) ORDER BY session_id LIMIT 1` });
          if (queued.rows.length) id = Number((queued.rows[0] as Record<string, unknown>).session_id);
          else { await wait(options.idleMs ?? 1000); continue; }
        }
        if (stopped || signal.aborted) break;
        workSessionId = id;
        cursor = id;
        await rememberBackfillCursor(id, signal);
        await processDashboardSession(id, { ...options.publicationHooks, signal });
        visited++;
        if (visited % BATCH_SIZE === 0) await checkpointYield();
      } catch (error) {
        if (stopped || signal.aborted) break;
        console.error("[DashboardProcessor] Session processing failed:", error);
        if (workSessionId !== null) {
          await recordProcessingFailure(workSessionId, signal).catch((recordError) => { if (!signal.aborted) console.error("[DashboardProcessor] Failed to persist retry state:", recordError); });
          workSessionId = null;
        }
        await wait(Math.min(30_000, 1000 * Math.max(1, visited)));
      }
    }
  };
  const done = run();
  return { stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    controller.abort();
    stopPromise = done;
    return stopPromise;
  } };
}
