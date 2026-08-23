import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  DEFAULT_LAP_CLASSIFICATION,
  type LapClassification,
} from "../../shared/racing/laps/classification";
import type { GameId } from "../../shared/games/ids";
import type { LapMeta, SessionOwnership } from "../../shared/racing/sessions/types";
import type {
  ArchiveVerification,
  EligibilityDecisionSet,
  EvidenceSourceKind,
  LapQualitySummary,
  RecordingQualitySummary,
  SourceChannelProfile,
} from "../../shared/racing/quality/contracts";
import type { LivePitData, LiveSectorData } from "../../shared/racing/live/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import {
  RaceEventsAppendedMessageSchema,
  RaceEventsReplacedMessageSchema,
  type RaceEvent,
} from "../../shared/racing/events/contracts";
import type { LiveProjection } from "./live-projector";
import { TELEMETRY_CATALOG_HASH, TELEMETRY_CATALOG_SCHEMA_VERSION, TELEMETRY_CATALOG_VERSION } from "../../shared/telemetry/catalog/data";
import { TELEMETRY_DERIVATION_VERSION } from "../../shared/telemetry/derivations/builtins";
import { TELEMETRY_PARSER_VERSIONS, TELEMETRY_RESOLVER_VERSION } from "../../shared/telemetry/resolver/versions";
import { insertSession, updateSessionQuality as persistSessionQuality, updateSessionRawFile, updateSessionCarTrack } from "../db/session-queries";
import { insertLap, setLapMetrics, type PersistLapInput } from "../db/lap-mutation-queries";
import { getLaps } from "../db/lap-read-queries";
import { getLapsForExclusionScope, setLapAutoExclusion, getLapExperimentScope } from "../db/experiment-lap-queries";
import { notifyDriverProfileLap } from "../driver-profile/runner";
import type { ExclusionScopeLap } from "../experiments/auto-exclude";
import { getTuneAssignment } from "../db/tune-queries";
import { SessionRecorder } from "../session-capture/recorder";
import { finalizeRecordingQualityGeneration } from "../lap-analysis/quality-generation";
import { resolveDataDir } from "../runtime/config/data-dir";

export function currentTelemetryVersionIdentity(gameId: GameId): TelemetryVersionIdentity {
  return {
    catalogVersion: TELEMETRY_CATALOG_VERSION,
    catalogHash: TELEMETRY_CATALOG_HASH,
    catalogSchemaVersion: TELEMETRY_CATALOG_SCHEMA_VERSION,
    parserVersion: TELEMETRY_PARSER_VERSIONS[gameId],
    resolverVersion: TELEMETRY_RESOLVER_VERSION,
    derivationVersion: TELEMETRY_DERIVATION_VERSION,
  };
}

export interface CapturedSession {
  carOrdinal: number;
  trackOrdinal: number;
  gameId: GameId;
  sessionType?: string;
  versionIdentity?: TelemetryVersionIdentity;
  sourceKind?: EvidenceSourceKind;
  sourceChannelProfile?: SourceChannelProfile;
  ownership?: SessionOwnership;
}

export interface CapturedLap extends LapClassification {
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  rawByteOffset: number | null;
  rawFrameCount: number;
  profileId: number | null;
  tuneId: number | null;
  invalidReason: string | null;
  sectors: number[] | null;
  /** Populated by parseDump helpers for test assertions only — not present in production. */
  packets?: TelemetryPacket[];
  versionIdentity?: TelemetryVersionIdentity;
  quality: LapQualitySummary | null;
  eligibility: EligibilityDecisionSet | null;
}

export interface DbAdapter {
  insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string,
    versionIdentity?: TelemetryVersionIdentity,
    sourceKind?: EvidenceSourceKind,
    sourceChannelProfile?: SourceChannelProfile,
    ownership?: SessionOwnership,
  ): Promise<number>;
  insertLap(input: PersistLapInput): Promise<number>;
  /** Persist precomputed per-lap fuel/tyre metrics (migration v32 columns).
   *  Called right after insertLap so /lap-metrics is a pure column read and
   *  never has to decode telemetry on first open. */
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void>;
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]>;
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void>;
  updateSessionQuality(sessionId: number, quality: RecordingQualitySummary): Promise<RecordingQualitySummary>;
  updateSessionCarTrack(sessionId: number, carOrdinal: number, trackOrdinal: number): Promise<void>;
  getTuneAssignment(gameId: GameId, carOrdinal: number, trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null>;
  /** Auto-exclude fastest-5 curation (server/experiments/auto-exclude.ts). */
  getLapsForExclusionScope(experimentId: number, tuneId: number): Promise<ExclusionScopeLap[]>;
  setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void>;
  getLapExperimentScope(lapId: number): Promise<{ experimentId: number | null; tuneId: number | null }>;
}

/**
 * Pluggable session recorder — wraps the raw binary dump file pipeline uses
 * to replay sessions later. Real impl writes to `<DATA_DIR>/sessions/<game>/`.
 * Null impl no-ops so tests re-feeding dumps don't duplicate the recording
 * back to disk.
 *
 * `epoch` bumps on each successful `start()` so the pipeline can detect a
 * session rotation triggered inside `detector.feed` (packet landed on the
 * old recorder, a new session opened, need to re-write the packet).
 */
export interface SessionRecorderAdapter {
  readonly active: boolean;
  readonly path: string | null;
  readonly epoch: number;
  start(gameId: GameId): void;
  writeMetaFrame(): void;
  writeRecord(buf: Buffer): void;
  getCurrentByteOffset(): number;
  flush(): void;
  stop(): Promise<ArchiveVerification>;
}

export interface LiveTelemetryPublication {
  packet: TelemetryPacket;
  sectors?: LiveSectorData | null;
  pit?: LivePitData | null;
  liveIssues?: TuneIssue[];
  projection?: LiveProjection;
}


export interface WsAdapter {
  /** Legacy packet capture hook retained for callers/tests. */
  broadcast(packet: TelemetryPacket, sectors?: LiveSectorData | null, pit?: LivePitData | null, liveIssues?: TuneIssue[]): void;
  readonly wantsDevTelemetry?: boolean;
  stageDevTelemetry(packet: TelemetryPacket): void;
  publishTelemetry(publication: LiveTelemetryPublication): void;
  broadcastNotification(event: Record<string, unknown>): void;
  broadcastDevState(state: Record<string, unknown>): void;
}
export interface RaceEventPublisher {
  publishAppended(sessionId: number, events: readonly RaceEvent[]): void;
  publishReplaced(sessionId: number): void;
}

/** Validates browser-safe event messages at publication edge. */
export class WsRaceEventPublisher implements RaceEventPublisher {
  private readonly ws: WsAdapter;

  constructor(ws: WsAdapter) {
    this.ws = ws;
  }

  publishAppended(sessionId: number, events: readonly RaceEvent[]): void {
    if (events.length === 0) return;
    this.ws.broadcastNotification(
      RaceEventsAppendedMessageSchema.parse({
        type: "race-events-appended",
        sessionId,
        events: [...events],
      }),
    );
  }

  publishReplaced(sessionId: number): void {
    this.ws.broadcastNotification(
      RaceEventsReplacedMessageSchema.parse({
        type: "race-events-replaced",
        sessionId,
      }),
    );
  }
}

export class NullRaceEventPublisher implements RaceEventPublisher {
  publishAppended(_sessionId: number, _events: readonly RaceEvent[]): void {}
  publishReplaced(_sessionId: number): void {}
}

export interface RealDbAdapterOptions {
  notifyDriverProfile?: boolean;
  ownership?: SessionOwnership;
  source?: EvidenceSourceKind;
  sourceChannelProfile?: SourceChannelProfile;
}

/** Delegates to the real query functions. Used in production. */
export class RealDbAdapter implements DbAdapter {
  private readonly sessionScopes = new Map<
    number,
    {
      gameId: GameId;
      carOrdinal: number;
      trackOrdinal: number;
      versionIdentity: TelemetryVersionIdentity;
    }
  >();
  private readonly options: RealDbAdapterOptions;

  constructor(options: RealDbAdapterOptions = {}) {
    this.options = options;
  }

  async insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string,
    versionIdentity?: TelemetryVersionIdentity,
    sourceKind?: EvidenceSourceKind,
    sourceChannelProfile?: SourceChannelProfile,
    ownership?: SessionOwnership,
  ): Promise<number> {
    const identity = versionIdentity ?? currentTelemetryVersionIdentity(gameId);
    const sessionId = await insertSession(
      carOrdinal,
      trackOrdinal,
      gameId,
      sessionType,
      identity,
      ownership ?? this.options.ownership,
      sourceKind ?? this.options.source ?? "native-live",
      sourceChannelProfile ?? this.options.sourceChannelProfile,
    );
    this.sessionScopes.set(sessionId, {
      gameId,
      carOrdinal,
      trackOrdinal,
      versionIdentity: identity,
    });
    return sessionId;
  }

  async insertLap(input: PersistLapInput): Promise<number> {
    const scope = this.sessionScopes.get(input.sessionId);
    const lapId = await insertLap({
      ...input,
      versionIdentity: input.versionIdentity ?? scope?.versionIdentity,
    });
    if (scope && this.options.notifyDriverProfile !== false) notifyDriverProfileLap(scope.gameId);
    return lapId;
  }
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
    return setLapMetrics(lapId, fuelPerLap, tyreWear);
  }
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return getLaps(gameId, limit);
  }
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string): Promise<void> {
    return updateSessionRawFile(sessionId, rawFile, lapDetectorVersion);
  }
  updateSessionQuality(sessionId: number, quality: RecordingQualitySummary): Promise<RecordingQualitySummary> {
    return persistSessionQuality(sessionId, quality);
  }
  async updateSessionCarTrack(sessionId: number, carOrdinal: number, trackOrdinal: number): Promise<void> {
    await updateSessionCarTrack(sessionId, carOrdinal, trackOrdinal);
    const existing = this.sessionScopes.get(sessionId);
    if (existing) this.sessionScopes.set(sessionId, { ...existing, carOrdinal, trackOrdinal });
  }
  getTuneAssignment(gameId: GameId, carOrdinal: number, trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null> {
    return getTuneAssignment(gameId, carOrdinal, trackOrdinal);
  }
  getLapsForExclusionScope(experimentId: number, tuneId: number): Promise<ExclusionScopeLap[]> {
    return getLapsForExclusionScope(experimentId, tuneId);
  }
  setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
    return setLapAutoExclusion(lapId, excluded);
  }
  getLapExperimentScope(lapId: number): Promise<{ experimentId: number | null; tuneId: number | null }> {
    return getLapExperimentScope(lapId);
  }
}

/** Captures insertSession/insertLap calls in-memory. Used in tests via parseDump. */
export class CapturingDbAdapter implements DbAdapter {
  readonly sessions: CapturedSession[] = [];
  readonly laps: CapturedLap[] = [];
  private _sessionId = 0;
  private _lapId = 0;

  insertSession(
    carOrdinal: number,
    trackOrdinal: number,
    gameId: GameId,
    sessionType?: string,
    versionIdentity?: TelemetryVersionIdentity,
    sourceKind: EvidenceSourceKind = "native-live",
    sourceChannelProfile?: SourceChannelProfile,
    ownership?: SessionOwnership,
  ): Promise<number> {
    this.sessions.push({
      carOrdinal,
      trackOrdinal,
      gameId,
      sessionType,
      versionIdentity,
      sourceKind,
      sourceChannelProfile,
      ownership,
    });
    return Promise.resolve(++this._sessionId);
  }

  insertLap(input: PersistLapInput): Promise<number> {
    const { classification = DEFAULT_LAP_CLASSIFICATION, ...captured } = input;
    this.laps.push({ ...captured, ...classification });
    return Promise.resolve(++this._lapId);
  }

  readonly sessionQuality = new Map<number, RecordingQualitySummary>();
  readonly sessionQualities: Array<{
    sessionId: number;
    quality: RecordingQualitySummary;
  }> = [];
  updateSessionQuality(
    sessionId: number,
    quality: RecordingQualitySummary,
  ): Promise<RecordingQualitySummary> {
    const finalized = finalizeRecordingQualityGeneration(quality);
    this.sessionQuality.set(sessionId, finalized);
    this.sessionQualities.push({ sessionId, quality: finalized });
    return Promise.resolve(finalized);
  }
  readonly lapMetrics: {
    lapId: number;
    fuelPerLap: number | null;
    tyreWear: number | null;
  }[] = [];
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
    this.lapMetrics.push({ lapId, fuelPerLap, tyreWear });
    return Promise.resolve();
  }

  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
  }

  updateSessionRawFile(_sessionId: number, _rawFile: string, _lapDetectorVersion: string): Promise<void> {
    return Promise.resolve();
  }

  updateSessionCarTrack(sessionId: number, carOrdinal: number, trackOrdinal: number): Promise<void> {
    // Backfill the captured session in place so tests observe the resolved ordinals.
    const session = this.sessions[sessionId - 1];
    if (session) {
      session.carOrdinal = carOrdinal;
      session.trackOrdinal = trackOrdinal;
    }
    return Promise.resolve();
  }

  getTuneAssignment(_gameId: GameId, _carOrdinal: number, _trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null> {
    return Promise.resolve(null);
  }

  readonly exclusionWrites: { lapId: number; excluded: boolean }[] = [];
  getLapsForExclusionScope(_experimentId: number, _tuneId: number): Promise<ExclusionScopeLap[]> {
    return Promise.resolve([]);
  }
  setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
    this.exclusionWrites.push({ lapId, excluded });
    return Promise.resolve();
  }
  getLapExperimentScope(_lapId: number): Promise<{ experimentId: number | null; tuneId: number | null }> {
    return Promise.resolve({ experimentId: null, tuneId: null });
  }
}

/** No-op WebSocket adapter. Used in tests. */
export class NullWsAdapter implements WsAdapter {
  readonly wantsDevTelemetry = false;
  broadcast(_packet: TelemetryPacket, _sectors?: LiveSectorData | null, _pit?: LivePitData | null, _liveIssues?: TuneIssue[]): void {}
  stageDevTelemetry(_packet: TelemetryPacket): void {}
  publishTelemetry(_publication: LiveTelemetryPublication): void {}
  broadcastNotification(_event: Record<string, unknown>): void {}
  broadcastDevState(_state: Record<string, unknown>): void {}
}

/** No-op database adapter. Used in benchmarks and tests that don't need DB output. */
export class NullDbAdapter implements DbAdapter {
  insertSession(
    _carOrdinal: number,
    _trackOrdinal: number,
    _gameId: GameId,
    _sessionType?: string,
    _versionIdentity?: TelemetryVersionIdentity,
    _sourceKind?: EvidenceSourceKind,
    _sourceChannelProfile?: SourceChannelProfile,
    _ownership?: SessionOwnership,
  ): Promise<number> {
    return Promise.resolve(1);
  }
  insertLap(_input: PersistLapInput): Promise<number> {
    return Promise.resolve(1);
  }
  setLapMetrics(_lapId: number, _fuelPerLap: number | null, _tyreWear: number | null): Promise<void> {
    return Promise.resolve();
  }
  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
  }
  updateSessionRawFile(_sessionId: number, _rawFile: string, _lapDetectorVersion: string): Promise<void> {
    return Promise.resolve();
  }
  updateSessionQuality(
    _sessionId: number,
    quality: RecordingQualitySummary,
  ): Promise<RecordingQualitySummary> {
    return Promise.resolve(finalizeRecordingQualityGeneration(quality));
  }
  updateSessionCarTrack(
    _sessionId: number,
    _carOrdinal: number,
    _trackOrdinal: number,
  ): Promise<void> {
    return Promise.resolve();
  }
  getTuneAssignment(_gameId: GameId, _carOrdinal: number, _trackOrdinal: number): Promise<{ carOrdinal: number; trackOrdinal: number; tuneId: number; tuneName: string } | null> {
    return Promise.resolve(null);
  }
  getLapsForExclusionScope(_experimentId: number, _tuneId: number): Promise<ExclusionScopeLap[]> {
    return Promise.resolve([]);
  }
  setLapAutoExclusion(_lapId: number, _excluded: boolean): Promise<void> {
    return Promise.resolve();
  }
  getLapExperimentScope(_lapId: number): Promise<{ experimentId: number | null; tuneId: number | null }> {
    return Promise.resolve({ experimentId: null, tuneId: null });
  }
}

/** Real session recorder — writes telemetry records to `<DATA_DIR>/sessions/<game>/<timestamp>.bin`. */
export class RealSessionRecorderAdapter implements SessionRecorderAdapter {
  private _inner: SessionRecorder | null = null;
  private _epoch = 0;

  get active(): boolean {
    return this._inner?.recording ?? false;
  }
  get path(): string | null {
    return this._inner?.path ?? null;
  }
  get epoch(): number {
    return this._epoch;
  }

  start(gameId: GameId): void {
    const dataDir = resolveDataDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionDir = resolve(dataDir, "sessions", gameId);
    mkdirSync(sessionDir, { recursive: true });
    const filePath = resolve(sessionDir, `${timestamp}.bin`);
    this._inner = new SessionRecorder();
    this._inner.start(filePath);
    this._epoch++;
  }

  writeMetaFrame(): void {
    this._inner?.writeMetaFrame();
  }
  writeRecord(buf: Buffer): void {
    this._inner?.writeRecord(buf);
  }
  getCurrentByteOffset(): number {
    return this._inner?.getCurrentByteOffset() ?? 0;
  }
  flush(): void {
    this._inner?.flush();
  }
  async stop(): Promise<ArchiveVerification> {
    const inner = this._inner;
    this._inner = null;
    return inner
      ? inner.stop()
      : {
          state: "unavailable",
          sourceGeneration: null,
          details: "Recorder was not active",
        };
  }
}

/** No-op session recorder — used in tests/benchmarks that re-feed recorded dumps. */
export class NullSessionRecorderAdapter implements SessionRecorderAdapter {
  get active(): boolean {
    return false;
  }
  get path(): string | null {
    return null;
  }
  get epoch(): number {
    return 0;
  }
  start(_gameId: GameId): void {}
  writeMetaFrame(): void {}
  writeRecord(_buf: Buffer): void {}
  getCurrentByteOffset(): number {
    return 0;
  }
  flush(): void {}
  async stop(): Promise<ArchiveVerification> {
    return {
      state: "unavailable",
      sourceGeneration: null,
      details: "Recording disabled",
    };
  }
}
/** Capturing WebSocket adapter that records all events. Used in tests. */
export class CapturingWsAdapter implements WsAdapter {
  readonly broadcastedPackets: Array<{ packet: TelemetryPacket; sectors?: LiveSectorData | null; pit?: LivePitData | null; liveIssues?: TuneIssue[] }> = [];
  readonly broadcastedNotifications: Record<string, unknown>[] = [];
  readonly broadcastedDevStates: Record<string, unknown>[] = [];
  readonly stagedDevTelemetry: TelemetryPacket[] = [];
  private readonly capturePackets: boolean;
  readonly wantsDevTelemetry = true;
  constructor(capturePackets = true) {
    this.capturePackets = capturePackets;
  }
  broadcast(packet: TelemetryPacket, sectors?: LiveSectorData | null, pit?: LivePitData | null, liveIssues?: TuneIssue[]): void {
    if (this.capturePackets) this.broadcastedPackets.push({ packet, sectors, pit, liveIssues });
  }
  stageDevTelemetry(packet: TelemetryPacket): void {
    this.stagedDevTelemetry.push(packet);
  }
  publishTelemetry(publication: LiveTelemetryPublication): void {
    this.broadcast(publication.packet, publication.sectors, publication.pit, publication.liveIssues);
  }
  broadcastNotification(event: Record<string, unknown>): void {
    this.broadcastedNotifications.push(event);
  }
  broadcastDevState(state: Record<string, unknown>): void {
    this.broadcastedDevStates.push(state);
  }
}
