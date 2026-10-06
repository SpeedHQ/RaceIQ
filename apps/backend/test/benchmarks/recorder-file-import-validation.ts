import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { GameId } from "@raceiq/shared/games/ids";
import { releaseFeatureFlags } from "@raceiq/shared/platform/runtime/release-feature-flags";
import { iterateSessionCaptureRecordsFromSource, type SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import { parseRawLapFrames } from "@raceiq/backend-core/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../src/games/init";

export interface FileImportResponse {
  ok: true;
  gameId: string;
  packetCount: number;
  imported: number;
  laps: unknown[];
}

interface SessionRow {
  id: number;
  gameId: string;
  ownership: string;
  source: string | null;
  carOrdinal: number;
  trackOrdinal: number;
  carId: string | null;
  trackId: string | null;
  sessionType: string | null;
  rawFile: string | null;
}

interface LapRow {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: number;
  invalidReason: string | null;
  sectorTimes: string | null;
  rawByteOffset: number | null;
  rawFrameCount: number | null;
  fuelPerLap: number | null;
  tyreWear: number | null;
  carSetup: string | null;
  insights: string | null;
  segmentStats: string | null;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface FileImportLapOutcome {
  session: {
    gameId: string;
    ownership: string;
    source: string | null;
    carId: string | number;
    trackId: string | number;
    sessionType: string | null;
  };
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  invalidReason: string | null;
  finalized: boolean;
  sectorTimes: number[] | null;
  fuelPerLap: number | null;
  tyreWear: number | null;
  carSetup: JsonValue;
  // Frame ordinals express readable lap boundaries, independent of sparse byte encoding.
  captureStartFrame: number;
  captureEndFrameExclusive: number;
  rawFrameCount: number;
  replayPacketCount: number;
}

export interface FileImportValidation {
  persistedSessionCount: number;
  persistedLapCount: number;
  finalizedLapCount: number;
  metricLapCount: number;
  finalizedMetricLapCount: number;
  derivedMetricValueCount: number;
  analysisMetricCount: number;
  captureCount: number;
  captureBytes: number;
  captureRecords: number;
  outcomeSha256: string;
  lapOutcomes: FileImportLapOutcome[];
  sessionOutcomes: { session: FileImportLapOutcome["session"]; laps: FileImportLapOutcome[] }[];
  validationIssues: string[];
  validationPassed: boolean;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error(`Invalid ${label}: ${String(value)}`);
  return value;
}

function normalizedNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw Error(`Non-finite ${label}`);
  // Keep microsecond timing precision without hashing binary floating-point noise.
  return Math.round(value * 1e6) / 1e6;
}

function normalizeJson(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return normalizedNumber(value, label);
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item, label));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalizeJson(item, `${label}.${key}`)]));
  }
  throw Error(`Invalid JSON value in ${label}`);
}

function parseJson(value: string | null, label: string): JsonValue {
  return value === null ? null : normalizeJson(JSON.parse(value), label);
}

function compareOutcomes(a: unknown, b: unknown): number {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Validate only after timing. Requires the benchmark's fresh, isolated app.db. */
export async function validateFileImport(dataDir: string, gameId: string, response: FileImportResponse): Promise<FileImportValidation> {
  if (!response || response.ok !== true || response.gameId !== gameId || !Array.isArray(response.laps)) throw Error("Import response identity or shape mismatch");
  if (count(response.packetCount, "response packet count") === 0) throw Error("Import accepted no source packets");
  if (count(response.imported, "response imported count") !== response.laps.length) throw Error("Import response count differs from returned laps");

  const root = await realpath(dataDir);
  using db = new Database(join(root, "app.db"), { readonly: true });
  const sessions = db.query<SessionRow, []>(`
    SELECT id, game_id AS gameId, ownership, source, car_ordinal AS carOrdinal,
      track_ordinal AS trackOrdinal, car_id AS carId, track_id AS trackId,
      session_type AS sessionType, raw_file AS rawFile FROM sessions
  `).all();
  if (sessions.length === 0) throw Error("Import persisted no sessions");
  if (sessions.some((session) => session.gameId !== gameId || session.ownership !== "mine")) throw Error("Import persisted unexpected game or ownership in isolated database");
  const laps = db.query<LapRow, []>(`
    SELECT l.id, l.session_id AS sessionId, l.lap_number AS lapNumber,
      l.lap_time AS lapTime, l.is_valid AS isValid, l.invalid_reason AS invalidReason,
      l.sector_times AS sectorTimes, l.raw_byte_offset AS rawByteOffset,
      l.raw_frame_count AS rawFrameCount, l.fuel_per_lap AS fuelPerLap,
      l.tyre_wear AS tyreWear, l.car_setup AS carSetup,
      m.insights, m.segment_stats AS segmentStats
    FROM laps l LEFT JOIN lap_metrics m ON m.lap_id = l.id
  `).all();
  if (laps.length !== response.imported) throw Error(`Import reported ${response.imported} laps but persisted ${laps.length}`);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const lapById = new Map(laps.map((lap) => [lap.id, lap]));
  const returnedIds = new Set<number>();
  const validationIssues: string[] = [];
  for (const value of response.laps) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("Malformed returned lap");
    const result = value as Record<string, unknown>;
    const lapId = count(result.lapId, "returned lap ID");
    const lap = lapById.get(lapId);
    const session = lap && sessionById.get(lap.sessionId);
    if (!lap || !session || returnedIds.has(lapId)) throw Error(`Returned lap ${lapId} is missing, orphaned or duplicated`);
    returnedIds.add(lapId);
    if (result.sessionId !== lap.sessionId || result.lapNumber !== lap.lapNumber || result.lapTime !== lap.lapTime || result.isValid !== Boolean(lap.isValid) ||
      (result.carId !== session.carId && result.carId !== session.carOrdinal) || (result.trackId !== session.trackId && result.trackId !== session.trackOrdinal)) {
      validationIssues.push(`Lap ${lapId}: response fields ${JSON.stringify({ sessionId: result.sessionId, lapNumber: result.lapNumber, lapTime: result.lapTime, isValid: result.isValid, carId: result.carId, trackId: result.trackId })} differ from durable fields ${JSON.stringify({ sessionId: lap.sessionId, lapNumber: lap.lapNumber, lapTime: lap.lapTime, isValid: Boolean(lap.isValid), carId: session.carId, carOrdinal: session.carOrdinal, trackId: session.trackId, trackOrdinal: session.trackOrdinal })}`);
    }
  }

  initServerGameAdapters({ ...releaseFeatureFlags({ RACEIQ_FEATURE_F1_EXPERIMENTS: undefined, RACEIQ_FEATURE_IRACING_ADAPTER: undefined }), iracingAdapter: true });
  let captureBytes = 0, captureRecords = 0, metricLapCount = 0, derivedMetricValueCount = 0, analysisMetricCount = 0;
  const captureStats = new Map<string, { frames: number; starts: Map<number, number> }>();
  const sessionOutcomes: FileImportValidation["sessionOutcomes"] = [];
  for (const session of sessions) {
    if (!session.rawFile) throw Error(`Session ${session.id} has no capture path`);
    const rawFile = await realpath(session.rawFile);
    const localPath = relative(root, rawFile);
    if (localPath === ".." || localPath.startsWith("../") || isAbsolute(localPath)) throw Error(`Session ${session.id} capture escapes isolated data directory`);
    const source: SessionCaptureSource = { rawFile, gameId: gameId as GameId, source: session.source, carOrdinal: session.carOrdinal, trackOrdinal: session.trackOrdinal };
    const sessionLaps = laps.filter((lap) => lap.sessionId === session.id);
    let capture = captureStats.get(rawFile);
    if (!capture) {
      const info = await stat(rawFile);
      if (!info.isFile() || info.size === 0) throw Error(`Session ${session.id} capture is not a nonempty file`);
      const wantedOffsets = new Set(laps.filter((lap) => sessionById.get(lap.sessionId)?.rawFile === session.rawFile).map((lap) => lap.rawByteOffset));
      capture = { frames: 0, starts: new Map() };
      for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true })) {
        if (record.kind !== "frame") continue;
        if (wantedOffsets.has(record.offset)) capture.starts.set(record.offset, capture.frames);
        capture.frames++;
      }
      if (capture.frames === 0) throw Error(`Session ${session.id} capture has no readable records`);
      captureBytes += info.size;
      captureRecords += capture.frames;
      captureStats.set(rawFile, capture);
    }
    const identity: FileImportLapOutcome["session"] = {
      gameId: session.gameId, ownership: session.ownership, source: session.source,
      carId: session.carId ?? session.carOrdinal, trackId: session.trackId ?? session.trackOrdinal,
      sessionType: session.sessionType,
    };
    const outcomes: FileImportLapOutcome[] = [];
    for (const lap of sessionLaps) {
      const offset = count(lap.rawByteOffset, `lap ${lap.id} capture offset`);
      const frameCount = count(lap.rawFrameCount, `lap ${lap.id} capture frame count`);
      const start = capture.starts.get(offset);
      if (frameCount === 0 || start === undefined || start + frameCount > capture.frames) throw Error(`Lap ${lap.id} has missing or incomplete capture window`);
      count(lap.lapNumber, `lap ${lap.id} number`);
      if (lap.lapTime <= 0 || (lap.isValid !== 0 && lap.isValid !== 1)) throw Error(`Lap ${lap.id} has invalid timing or validity`);
      const sectors = parseJson(lap.sectorTimes, `lap ${lap.id} sectors`);
      if (sectors !== null && (!Array.isArray(sectors) || sectors.some((time) => typeof time !== "number" || time < 0))) throw Error(`Lap ${lap.id} has malformed sector times`);
      // Production replay streams one lap at a time; never materialize whole captures.
      const packets = await parseRawLapFrames(source, offset, frameCount);
      if (packets.length === 0) throw Error(`Lap ${lap.id} capture window produced no telemetry`);
      // Durable metrics use detector lapBuffer packets, not independently parsed
      // raw capture windows. Replay can derive values absent from that buffer.
      for (const [name, value] of [["fuel", lap.fuelPerLap], ["tyre wear", lap.tyreWear]] as const) {
        if (value !== null) {
          if (value < 0) throw Error(`Lap ${lap.id} has negative ${name} metric`);
          normalizedNumber(value, `lap ${lap.id} ${name}`);
          derivedMetricValueCount++;
        }
      }
      if (lap.fuelPerLap !== null || lap.tyreWear !== null) metricLapCount++;
      // Analysis cache is lazy, not required by import finalization. Validate any actual row.
      if (lap.insights !== null || lap.segmentStats !== null) {
        if (lap.insights === null || lap.segmentStats === null || !Array.isArray(parseJson(lap.insights, "lap insights")) || !Array.isArray(parseJson(lap.segmentStats, "lap segment stats"))) throw Error(`Lap ${lap.id} has malformed cached analysis metrics`);
        analysisMetricCount++;
      }
      outcomes.push({
        session: identity, lapNumber: lap.lapNumber, lapTime: normalizedNumber(lap.lapTime, "lap time"),
        isValid: Boolean(lap.isValid), invalidReason: lap.invalidReason, finalized: lap.invalidReason !== "incomplete",
        sectorTimes: sectors as number[] | null,
        fuelPerLap: lap.fuelPerLap === null ? null : normalizedNumber(lap.fuelPerLap, "fuel metric"),
        tyreWear: lap.tyreWear === null ? null : normalizedNumber(lap.tyreWear, "tyre metric"),
        carSetup: parseJson(lap.carSetup, "car setup"), captureStartFrame: start,
        captureEndFrameExclusive: start + frameCount, rawFrameCount: frameCount, replayPacketCount: packets.length,
      });
    }
    outcomes.sort(compareOutcomes);
    sessionOutcomes.push({ session: identity, laps: outcomes });
  }
  sessionOutcomes.sort(compareOutcomes);
  const lapOutcomes = sessionOutcomes.flatMap((session) => session.laps);
  return {
    persistedSessionCount: sessions.length, persistedLapCount: laps.length,
    finalizedLapCount: lapOutcomes.filter((lap) => lap.finalized).length,
    finalizedMetricLapCount: lapOutcomes.filter((lap) => lap.finalized && (lap.fuelPerLap !== null || lap.tyreWear !== null)).length,
    metricLapCount, derivedMetricValueCount, analysisMetricCount,
    captureCount: captureStats.size, captureBytes, captureRecords,
    outcomeSha256: createHash("sha256").update(JSON.stringify(sessionOutcomes)).digest("hex"),
    lapOutcomes, sessionOutcomes,
    validationIssues, validationPassed: validationIssues.length === 0,
  };
}
