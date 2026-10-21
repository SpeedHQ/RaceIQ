import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionOwnership } from "@raceiq/shared/racing/sessions/types";
import type { LivePitData, LiveSectorData } from "@raceiq/shared/racing/live/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { TelemetryVersionIdentity } from "@raceiq/shared/telemetry/version";
import type { TuneIssue } from "@raceiq/shared/racing/tuning/issues";
import type { LiveProjection } from "@raceiq/telemetry-core/telemetry/live-projector";
import {
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
} from "@raceiq/shared/telemetry/catalog/data";
import { TELEMETRY_DERIVATION_VERSION } from "@raceiq/telemetry-core/telemetry/derivations/builtins";
import {
  TELEMETRY_PARSER_VERSIONS,
  TELEMETRY_RESOLVER_VERSION,
} from "@raceiq/shared/telemetry/resolver/versions";
import { insertSession, updateSessionRawFile, updateSessionCarTrack, markSessionCaptureFormatCurrent, type SessionSourceOrigin } from "../db/session-queries";
import { deleteLapOnly, insertLap, updateCapturedLap, setLapMetrics, updateLapCarSetup as updateLapCarSetupQuery } from "../db/lap-mutation-queries";
import { getLaps } from "../db/lap-read-queries";
import { getLapsForExclusionScope, setLapAutoExclusion, getLapExperimentScope } from "../db/experiment-lap-queries";
import { notifyDriverProfileLap } from "../driver-profile/lap-notifier";
import type { ExclusionScopeLap } from "../experiments/auto-exclude";
import { getTuneAssignment } from "../db/tune-queries";
import { WorkerSessionRecorder, type WorkerRecorderOptions } from "@raceiq/capture-formats/session/worker-recorder";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { resolveRecordingGameDirectory } from "../runtime/config/recording-directory";
import { timestampForFilename } from "../session-capture/filename";
import { notifyOnlineSync } from "@raceiq/online/sync-events";
import type { GameIdentityBinding } from "@raceiq/online/contracts";
import type { DriverAttributionStint, LapDriverAttribution, NativeDriverActor } from "@raceiq/shared/driver-attribution";
import { getLocalGameBindingSnapshot, upsertLocalGameBinding } from "../db/local-account-queries";
import { setLapDriverAttribution, replaceSessionDriverAttributionStints } from "../db/driver-summary-ledger-queries";
import { closeNativeOriginalActivitySource, finalizeNativeOriginalActivitySource } from "../db/original-activity-queries";
import { encodeNativeDriverBinding } from "../lap-detection/native-attribution";

const AC_EVO_LOCAL_ROLE_IDENTITY = JSON.stringify({ schemaVersion: 1, actorId: "ac-evo-control:local-player", bindingScope: "installation" });
const LMU_LOCAL_ROLE_IDENTITY = JSON.stringify({ schemaVersion: 1, actorId: "lmu-control:0", bindingScope: "installation" });

export interface CapturedDriverAttribution {
  stints: DriverAttributionStint[];
  attribution: LapDriverAttribution;
  source: { domain: string; startMs: number; endMs: number };
}

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
export interface SessionIdentity {
  carId: string;
  trackId: string;
}


export interface CapturedSession {
  carId: string;
  trackId: string;
  gameId: GameId;
  sessionType?: string;
  versionIdentity?: TelemetryVersionIdentity;
  ownership?: SessionOwnership;
}

export interface CapturedLap {
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
  rawByteOffset: number | null;
  rawFrameCount: number;
  profileId: number | null;
  tuneId: number | null;
  invalidReason: string | null;
  classification: LapClassification | null;
  sectors: number[] | null;
  /** Populated by parseDump helpers for test assertions only — not present in production. */
  packets?: TelemetryPacket[];
  versionIdentity?: TelemetryVersionIdentity;
  driverAttribution?: CapturedDriverAttribution;
}

export interface PersistedLapBinding {
  sessionId: number;
  lapId: number;
  lapNumber: number;
  startByteOffset: number;
  frameCount: number;
}

export interface DbAdapter {
  getDriverBindings(actor?: NativeDriverActor | null): Promise<{ revision: number; bindings: GameIdentityBinding[] }>;
  setSessionDriverAttribution(sessionId: number, stints: readonly DriverAttributionStint[]): Promise<void>;
  /** Only a genuine fully drained native source close may publish complete original coverage. */
  finalizeOriginalActivitySource(sessionId: number): Promise<void>;
  insertSession(
    carId: string,
    trackId: string,
    gameId: GameId,
    sessionType?: string,
    versionIdentity?: TelemetryVersionIdentity,
    ownership?: SessionOwnership,
  ): Promise<number>;
  insertLap(
    sessionId: number,
    lapNumber: number,
    lapTime: number,
    isValid: boolean,
    rawByteOffset: number | null,
    rawFrameCount: number,
    profileId: number | null,
    tuneId: number | null,
    invalidReason: string | null,
    sectors: number[] | null,
    classification: LapClassification | null,
    versionIdentity?: TelemetryVersionIdentity,
    driverAttribution?: CapturedDriverAttribution,
  ): Promise<number>;
  /** Complete the exact retained provisional row without changing its durable identity. */
  completeProvisionalLap(lapId: number, ...args: Parameters<DbAdapter["insertLap"]>): Promise<number>;
  deleteLap(lapId: number): Promise<void>;
  /** Persist precomputed per-lap fuel/tyre metrics (migration v32 columns).
   *  Called right after insertLap so /lap-metrics is a pure column read and
   *  never has to decode telemetry on first open. */
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void>;
  updateLapCarSetup(lapId: number, carSetup: object | null): Promise<void>;
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]>;
  updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string, sparseCapture?: boolean): Promise<void>;
  updateSessionCarTrack(sessionId: number, carId: string, trackId: string): Promise<void>;
  getTuneAssignment(gameId: GameId, carId: string, trackId: string): Promise<{ carId: string; trackId: string; tuneId: number; tuneName: string } | null>;
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
  writeRecord(buf: Buffer, frameTimeMs?: number): void;
  requestFullCheckpoint?(): void;
  writeRawCaptureBytes(buf: Buffer): void;
  writeSegmentBoundary(): void;
  getCurrentByteOffset(): number;
  flush(): void;
  stop(): Promise<void>;
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
  readonly wantsDevState: boolean;
  stageDevTelemetry(packet: TelemetryPacket): void;
  publishTelemetry(publication: LiveTelemetryPublication): void;
  broadcastNotification(event: Record<string, unknown>): void;
  broadcastDevState(state: Record<string, unknown>): void;
}

/** Delegates to the real query functions. Used in production. */
export class RealDbAdapter implements DbAdapter {
  private readonly lapBindingListeners = new Set<(binding: PersistedLapBinding) => void>();
  private readonly pendingLapWrites = new Map<number, Set<Promise<number>>>();
  private readonly lapWriteFailures = new Map<number, Error>();
  private readonly lapWriteFailureListeners = new Set<(sessionId: number, error: Error) => void>();
  private readonly lapInvalidationListeners = new Set<(lapId: number) => void>();

  async drainLapWrites(sessionId: number): Promise<void> {
    const writes = this.pendingLapWrites.get(sessionId);
    let rejectedWrite: Error | null = null;
    if (writes) {
      const results = await Promise.allSettled(writes);
      for (const result of results) {
        if (result.status === "rejected" && !rejectedWrite) {
          rejectedWrite = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        }
      }
    }
    // A failed source write is not repaired by a second drain. Never certify its partial membership.
    const failure = this.lapWriteFailures.get(sessionId) ?? rejectedWrite;
    if (failure) throw failure;
  }

  subscribeLapBindings(listener: (binding: PersistedLapBinding) => void): () => void {
    this.lapBindingListeners.add(listener);
    return () => this.lapBindingListeners.delete(listener);
  }

  subscribeLapWriteFailures(listener: (sessionId: number, error: Error) => void): () => void {
    this.lapWriteFailureListeners.add(listener);
    return () => this.lapWriteFailureListeners.delete(listener);
  }

  subscribeLapInvalidations(listener: (lapId: number) => void): () => void {
    this.lapInvalidationListeners.add(listener);
    return () => this.lapInvalidationListeners.delete(listener);
  }
  private readonly sessionScopes = new Map<number, {
    gameId: GameId;
    carId: string;
    trackId: string;
    versionIdentity: TelemetryVersionIdentity;
    lapIds: Set<number>;
    sourceRevision: string | null;
  }>();
  private readonly options: { notifyDriverProfile?: boolean; ownership?: SessionOwnership; sourceOrigin?: SessionSourceOrigin };
  private bindingSnapshot: Promise<{ revision: number; bindings: GameIdentityBinding[] }> | null = null;
  private bindingSnapshotAt = -Infinity;
  private f1NativeIdentity: { sessionId: string; actorId: string; value: string } | null = null;

  constructor(options: { notifyDriverProfile?: boolean; ownership?: SessionOwnership; sourceOrigin?: SessionSourceOrigin } = {}) {
    this.options = options;
  }

  invalidateDriverBindingSnapshot(): void {
    this.bindingSnapshot = null;
    this.bindingSnapshotAt = -Infinity;
  }

  async getDriverBindings(actor?: NativeDriverActor | null): Promise<{ revision: number; bindings: GameIdentityBinding[] }> {
    // This wall clock only throttles DB reads; it is never attribution/source evidence.
    const now = performance.now();
    if (!this.bindingSnapshot || now - this.bindingSnapshotAt >= 250) {
      this.bindingSnapshotAt = now;
      this.bindingSnapshot = getLocalGameBindingSnapshot().catch((error) => {
        this.bindingSnapshot = null;
        throw error;
      });
    }
    const snapshotPromise = this.bindingSnapshot;
    const snapshot = await snapshotPromise;
    const localRole = actor && (
      (actor.gameId === "ac-evo" && actor.source === "ac-evo-shared-memory" &&
        (actor.actorId === "ac-evo-control:local-player" || actor.actorId === "ac-evo-control:other") && actor.bindingScope === "installation") ||
      (actor.gameId === "lmu" && actor.source === "lmu-shared-memory-player-scoring" &&
        (actor.actorId === "lmu-control:0" || actor.actorId === "lmu-control:1" || actor.actorId === "lmu-control:2") && actor.bindingScope === "installation") ||
      (actor.gameId === "f1-2025" && actor.source === "f1-2025-udp-local-controller" &&
        actor.bindingScope === "session" && actor.actorId === (this.f1NativeIdentity?.sessionId === actor.sessionId
          ? this.f1NativeIdentity.actorId : `${actor.sessionId}:local-player`)));
    if (!localRole || this.options.sourceOrigin?.kind !== "native_capture") return snapshot;
    const existing = snapshot.bindings.find((binding) => binding.gameId === actor.gameId);
    if (existing && (existing.confirmation === "user_confirmed" || existing.sourceKind !== actor.source)) return snapshot;
    // Bind the SDK's defined local control role, not the currently observed actor.
    // A current AI/remote observation stays Other; no synthetic Self observation is made.
    if (actor.gameId === "f1-2025" && this.f1NativeIdentity?.sessionId !== actor.sessionId) {
      this.f1NativeIdentity = { sessionId: actor.sessionId, actorId: actor.actorId, value: encodeNativeDriverBinding(actor) };
    }
    const nativeIdentity = actor.gameId === "ac-evo" ? AC_EVO_LOCAL_ROLE_IDENTITY
      : actor.gameId === "lmu" ? LMU_LOCAL_ROLE_IDENTITY : this.f1NativeIdentity!.value;
    if (existing?.nativeIdentity === nativeIdentity) return snapshot;
    try {
      await upsertLocalGameBinding({ id: existing?.id ?? randomUUID(), gameId: actor.gameId,
        sourceKind: actor.source, nativeIdentity, confirmation: "native_verified", revision: (existing?.revision ?? 0) + 1 },
      { expectedSnapshotRevision: snapshot.revision, isCurrent: () => this.bindingSnapshot === snapshotPromise });
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "stale_state") throw error;
      // A concurrent explicit confirmation wins; observe its actual row without retrying a write.
      this.invalidateDriverBindingSnapshot();
      return this.getDriverBindings();
    }
    this.bindingSnapshot = getLocalGameBindingSnapshot();
    return this.bindingSnapshot;
  }
  setSessionDriverAttribution(sessionId: number, stints: readonly DriverAttributionStint[]): Promise<void> {
    return replaceSessionDriverAttributionStints(sessionId, stints);
  }
  setOriginalActivitySourceRevision(sessionId: number, sourceRevision: string): void {
    const scope = this.sessionScopes.get(sessionId);
    if (scope && sourceRevision.trim()) scope.sourceRevision = sourceRevision;
  }
  /** Release only after genuine source close; this never publishes coverage. */
  releaseSessionSourceTracking(sessionId: number): void {
    this.sessionScopes.delete(sessionId);
    this.lapWriteFailures.delete(sessionId);
  }
  async finalizeOriginalActivitySource(sessionId: number): Promise<void> {
    if (this.options.sourceOrigin?.kind !== "native_capture") return;
    await this.drainLapWrites(sessionId);
    const scope = this.sessionScopes.get(sessionId);
    if (!scope?.sourceRevision) return;
    // The actual manifest/observed-source revision is independent of the DB's
    // source-content equivalence hash and immutable original activity identity.
    await closeNativeOriginalActivitySource(sessionId, {
      sourceRevision: scope.sourceRevision, lapCount: scope.lapIds.size, gapCount: 0,
    });
    await finalizeNativeOriginalActivitySource(sessionId);
    this.releaseSessionSourceTracking(sessionId);
  }
  async insertSession(carId: string, trackId: string, gameId: GameId, sessionType?: string, versionIdentity?: TelemetryVersionIdentity, ownership?: SessionOwnership): Promise<number> {
    const identity = versionIdentity ?? currentTelemetryVersionIdentity(gameId);
    const sessionId = await insertSession(carId, trackId, gameId, sessionType, identity, ownership ?? this.options.ownership, this.options.sourceOrigin ?? { kind: "unknown" });
    this.sessionScopes.set(sessionId, { gameId, carId, trackId, versionIdentity: identity, lapIds: new Set(), sourceRevision: null });
    return sessionId;
  }

  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, rawByteOffset: number | null, rawFrameCount: number, profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: number[] | null, classification: LapClassification | null, versionIdentity?: TelemetryVersionIdentity, driverAttribution?: CapturedDriverAttribution): Promise<number> {
    return this.writeLap(null, sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, classification, versionIdentity, driverAttribution);
  }
  completeProvisionalLap(lapId: number, ...args: Parameters<DbAdapter["insertLap"]>): Promise<number> {
    return this.writeLap(lapId, ...args);
  }
  private writeLap(retainedLapId: number | null, sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, rawByteOffset: number | null, rawFrameCount: number, profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: number[] | null, classification: LapClassification | null, versionIdentity?: TelemetryVersionIdentity, driverAttribution?: CapturedDriverAttribution): Promise<number> {
    // Remove the short provisional capture binding before the engine seals its extended window.
    if (retainedLapId !== null) for (const listener of this.lapInvalidationListeners) listener(retainedLapId);
    let writes = this.pendingLapWrites.get(sessionId);
    if (!writes) {
      writes = new Set();
      this.pendingLapWrites.set(sessionId, writes);
    }
    const pending = (async () => {
      const scope = this.sessionScopes.get(sessionId);
      const lapId = retainedLapId === null
        ? await insertLap(sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, classification, versionIdentity ?? scope?.versionIdentity)
        : await updateCapturedLap(retainedLapId, sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, sectors, classification, versionIdentity ?? scope?.versionIdentity);
      if (driverAttribution) await setLapDriverAttribution(lapId, driverAttribution.stints, driverAttribution.attribution, driverAttribution.source);
      scope?.lapIds.add(lapId);
      if (scope && this.options.notifyDriverProfile !== false) notifyDriverProfileLap(scope.gameId);
      if (rawByteOffset !== null) {
        const binding = { sessionId, lapId, lapNumber, startByteOffset: rawByteOffset, frameCount: rawFrameCount };
        for (const listener of this.lapBindingListeners) listener(binding);
      }
      notifyOnlineSync();
      return lapId;
    })();
    writes.add(pending);
    void pending.finally(() => {
      writes.delete(pending);
      if (writes.size === 0) this.pendingLapWrites.delete(sessionId);
    }).catch(() => {});
    void pending.catch((failure) => {
      const error = failure instanceof Error ? failure : new Error(String(failure));
      this.lapWriteFailures.set(sessionId, error);
      for (const listener of this.lapWriteFailureListeners) listener(sessionId, error);
    });
    return pending;
  }
  async deleteLap(lapId: number): Promise<void> {
    await deleteLapOnly(lapId);
    for (const scope of this.sessionScopes.values()) scope.lapIds.delete(lapId);
    for (const listener of this.lapInvalidationListeners) listener(lapId);
  }
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
    return setLapMetrics(lapId, fuelPerLap, tyreWear);
  }
  updateLapCarSetup(lapId: number, carSetup: object | null): Promise<void> {
    return updateLapCarSetupQuery(lapId, carSetup);
  }
  getLaps(gameId: GameId, limit: number): Promise<LapMeta[]> {
    return getLaps(gameId, limit);
  }
  async updateSessionRawFile(sessionId: number, rawFile: string, lapDetectorVersion: string, sparseCapture = false): Promise<void> {
    await updateSessionRawFile(sessionId, rawFile, lapDetectorVersion);
    if (sparseCapture) await markSessionCaptureFormatCurrent(sessionId);
    notifyOnlineSync();
  }
  async updateSessionCarTrack(sessionId: number, carId: string, trackId: string): Promise<void> {
    await updateSessionCarTrack(sessionId, carId, trackId);
    const existing = this.sessionScopes.get(sessionId);
    if (existing) this.sessionScopes.set(sessionId, { ...existing, carId, trackId });
  }
  getLapsForExclusionScope(experimentId: number, tuneId: number): Promise<ExclusionScopeLap[]> {
    return getLapsForExclusionScope(experimentId, tuneId);
  }
  setLapAutoExclusion(lapId: number, excluded: boolean): Promise<void> {
    return setLapAutoExclusion(lapId, excluded);
  }
  getTuneAssignment(gameId: GameId, carId: string, trackId: string): Promise<{ carId: string; trackId: string; tuneId: number; tuneName: string } | null> {
    return getTuneAssignment(gameId, carId, trackId);
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
  private readonly _lapIds: number[] = [];
  readonly finalizedOriginalActivities: number[] = [];
  readonly sessionAttribution = new Map<number, readonly DriverAttributionStint[]>();
  driverBindings: { revision: number; bindings: GameIdentityBinding[] } = { revision: 0, bindings: [] };
  getDriverBindings(): Promise<{ revision: number; bindings: GameIdentityBinding[] }> {
    return Promise.resolve(this.driverBindings);
  }
  setSessionDriverAttribution(sessionId: number, stints: readonly DriverAttributionStint[]): Promise<void> {
    this.sessionAttribution.set(sessionId, structuredClone(stints));
    return Promise.resolve();
  }
  finalizeOriginalActivitySource(sessionId: number): Promise<void> {
    this.finalizedOriginalActivities.push(sessionId);
    return Promise.resolve();
  }

  insertSession(carId: string, trackId: string, gameId: GameId, sessionType?: string, versionIdentity?: TelemetryVersionIdentity, ownership?: SessionOwnership): Promise<number> {
    this.sessions.push({ carId, trackId, gameId, sessionType, versionIdentity, ownership });
    return Promise.resolve(++this._sessionId);
  }

  insertLap(sessionId: number, lapNumber: number, lapTime: number, isValid: boolean, rawByteOffset: number | null, rawFrameCount: number, profileId: number | null, tuneId: number | null, invalidReason: string | null, sectors: number[] | null, classification: LapClassification | null, versionIdentity?: TelemetryVersionIdentity, driverAttribution?: CapturedDriverAttribution): Promise<number> {
    this.laps.push({ sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId, invalidReason, classification, sectors, versionIdentity, driverAttribution });
    const id = ++this._lapId;
    this._lapIds.push(id);
    return Promise.resolve(id);
  }

  completeProvisionalLap(lapId: number, ...args: Parameters<DbAdapter["insertLap"]>): Promise<number> {
    const index = this._lapIds.indexOf(lapId);
    const existing = this.laps[index];
    const [sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId, tuneId,
      invalidReason, sectors, classification, versionIdentity, driverAttribution] = args;
    if (!existing || existing.sessionId !== sessionId || existing.lapNumber !== lapNumber ||
      existing.rawByteOffset !== rawByteOffset || existing.rawFrameCount > rawFrameCount || existing.isValid) {
      return Promise.reject(new Error("Provisional lap source window changed"));
    }
    this.laps[index] = { sessionId, lapNumber, lapTime, isValid, rawByteOffset, rawFrameCount, profileId,
      tuneId, invalidReason, classification, sectors, versionIdentity, driverAttribution };
    return Promise.resolve(lapId);
  }

  readonly lapMetrics: { lapId: number; fuelPerLap: number | null; tyreWear: number | null }[] = [];
  setLapMetrics(lapId: number, fuelPerLap: number | null, tyreWear: number | null): Promise<void> {
    this.lapMetrics.push({ lapId, fuelPerLap, tyreWear });
    return Promise.resolve();
  }
  updateLapCarSetup(_lapId: number, _carSetup: object | null): Promise<void> {
    return Promise.resolve();
  }
  deleteLap(lapId: number): Promise<void> {
    const index = this._lapIds.indexOf(lapId);
    if (index >= 0) {
      this._lapIds.splice(index, 1);
      this.laps.splice(index, 1);
    }
    return Promise.resolve();
  }

  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
  }

  updateSessionRawFile(_sessionId: number, _rawFile: string, _lapDetectorVersion: string): Promise<void> {
    return Promise.resolve();
  }

  updateSessionCarTrack(sessionId: number, carId: string, trackId: string): Promise<void> {
    const session = this.sessions[sessionId - 1];
    if (session) {
      session.carId = carId;
      session.trackId = trackId;
    }
    return Promise.resolve();
  }

  getTuneAssignment(_gameId: GameId, _carId: string, _trackId: string): Promise<{ carId: string; trackId: string; tuneId: number; tuneName: string } | null> {
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
  readonly wantsDevState = false;
  broadcast(_packet: TelemetryPacket, _sectors?: LiveSectorData | null, _pit?: LivePitData | null, _liveIssues?: TuneIssue[]): void {}
  stageDevTelemetry(_packet: TelemetryPacket): void {}
  publishTelemetry(_publication: LiveTelemetryPublication): void {}
  broadcastNotification(_event: Record<string, unknown>): void {}
  broadcastDevState(_state: Record<string, unknown>): void {}
}

/** No-op database adapter. Used in benchmarks and tests that don't need DB output. */
export class NullDbAdapter implements DbAdapter {
  getDriverBindings(): Promise<{ revision: number; bindings: GameIdentityBinding[] }> { return Promise.resolve({ revision: 0, bindings: [] }); }
  setSessionDriverAttribution(_sessionId: number, _stints: readonly DriverAttributionStint[]): Promise<void> { return Promise.resolve(); }
  finalizeOriginalActivitySource(_sessionId: number): Promise<void> { return Promise.resolve(); }
  insertSession(_carId: string, _trackId: string, _gameId: GameId, _sessionType?: string, _versionIdentity?: TelemetryVersionIdentity, _ownership?: SessionOwnership): Promise<number> {
    return Promise.resolve(1);
  }
  insertLap(_sessionId: number, _lapNumber: number, _lapTime: number, _isValid: boolean, _rawByteOffset: number | null, _rawFrameCount: number, _profileId: number | null, _tuneId: number | null, _invalidReason: string | null, _sectors: number[] | null, _classification: LapClassification | null, _versionIdentity?: TelemetryVersionIdentity, _driverAttribution?: CapturedDriverAttribution): Promise<number> {
    return Promise.resolve(1);
  }
  completeProvisionalLap(lapId: number, ..._args: Parameters<DbAdapter["insertLap"]>): Promise<number> {
    return Promise.resolve(lapId);
  }
  setLapMetrics(_lapId: number, _fuelPerLap: number | null, _tyreWear: number | null): Promise<void> {
    return Promise.resolve();
  }
  deleteLap(_lapId: number): Promise<void> {
    return Promise.resolve();
  }
  getLaps(_gameId: GameId, _limit: number): Promise<LapMeta[]> {
    return Promise.resolve([]);
  }
  updateLapCarSetup(_lapId: number, _carSetup: object | null): Promise<void> {
    return Promise.resolve();
  }
  updateSessionRawFile(_sessionId: number, _rawFile: string, _lapDetectorVersion: string): Promise<void> {
    return Promise.resolve();
  }
  updateSessionCarTrack(_sessionId: number, _carId: string, _trackId: string): Promise<void> {
    return Promise.resolve();
  }
  getTuneAssignment(_gameId: GameId, _carId: string, _trackId: string): Promise<{ carId: string; trackId: string; tuneId: number; tuneName: string } | null> {
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


let liveCaptureWorkerFactory: ((gameId: GameId) => Worker) | null = null;

/** Backend binds concrete worker codecs without importing game registries here. */
export function configureLiveCaptureWorkerFactory(factory: (gameId: GameId) => Worker): void {
  liveCaptureWorkerFactory = factory;
}

/** Production recorder; all supported games use sparse checkpoints where beneficial. */
export class SparseSessionRecorderAdapter implements SessionRecorderAdapter {
  private readonly ownership: SessionOwnership;
  private readonly workerOptions: WorkerRecorderOptions;
  private readonly mode: "live" | "offline";

  constructor(ownership: SessionOwnership = "mine", workerOptions: WorkerRecorderOptions = {}, mode: "live" | "offline" = "live") {
    this.ownership = ownership;
    this.workerOptions = workerOptions;
    this.mode = mode;
  }

  private inner: WorkerSessionRecorder | SparseSessionRecorder | null = null;
  private currentEpoch = 0;
  get active(): boolean { return this.inner?.recording ?? false; }
  get path(): string | null { return this.inner?.path ?? null; }
  get epoch(): number { return this.currentEpoch; }
  get workerRecorder(): WorkerSessionRecorder | null { return this.inner instanceof WorkerSessionRecorder ? this.inner : null; }
  /** Zero-based ordinal of the most recently accepted native source record. */
  get sourceOrdinal(): number | undefined {
    const count = this.inner?.recordCount;
    return count === undefined || count === 0 ? undefined : count - 1;
  }
  get supportsLiveSplitting(): boolean { return this.mode === "live" && liveCaptureWorkerFactory !== null; }

  start(gameId: GameId): void {
    const sessionDir = resolveRecordingGameDirectory(gameId, this.ownership);
    if (this.mode === "offline") this.inner = new SparseSessionRecorder(gameId);
    else {
      const worker = this.workerOptions.worker ?? liveCaptureWorkerFactory?.(gameId);
      const maxInFlightBytes = this.workerOptions.maxInFlightBytes ?? 16 * 1024 * 1024;
      this.inner = new WorkerSessionRecorder(gameId, { ...this.workerOptions, maxInFlightBytes,
        maxBatchBytes: this.workerOptions.maxBatchBytes ?? Math.min(4 * 1024 * 1024, maxInFlightBytes),
        worker, canonicalRawCaptureBytes: true });
    }
    this.inner.start(resolve(sessionDir, `${timestampForFilename()}-${randomUUID()}.bin`));
    this.currentEpoch++;
  }

  writeMetaFrame(): void { this.inner?.writeMetaFrame(); }
  requestFullCheckpoint(): void { this.inner?.requestFullCheckpoint(); }
  writeSegmentBoundary(): void { this.inner?.writeSegmentBoundary(); }
  writeRecord(frame: Buffer, frameTimeMs?: number): void { this.inner?.writeRecord(frame, frameTimeMs); }
  writeRawCaptureBytes(bytes: Buffer): void { this.inner?.writeRawCaptureBytes(bytes); }
  getCurrentByteOffset(): number { return this.inner?.getCurrentByteOffset() ?? 0; }
  flush(): void { this.inner?.flush(); }
  detachRecorder(): WorkerSessionRecorder | null {
    const recorder = this.inner;
    if (recorder && !(recorder instanceof WorkerSessionRecorder)) throw new Error("Cannot detach an offline recorder as a live worker");
    this.inner = null;
    return recorder;
  }
  async stop(): Promise<void> {
    const recorder = this.inner;
    this.inner = null;
    if (recorder) {
      try {
        await recorder.stop();
        notifyOnlineSync();
      } finally {
        if (recorder instanceof WorkerSessionRecorder && (liveCaptureWorkerFactory || this.workerOptions.worker)) await recorder.worker.terminate();
      }
    }
  }
}

/** No-op session recorder — used in tests/benchmarks that re-feed recorded dumps. */
export class NullSessionRecorderAdapter implements SessionRecorderAdapter {
  get active(): boolean { return false; }
  get path(): string | null { return null; }
  get epoch(): number { return 0; }
  start(_gameId: GameId): void {}
  writeMetaFrame(): void {}
  requestFullCheckpoint(): void {}
  writeRawCaptureBytes(_buf: Buffer): void {}
  writeRecord(_buf: Buffer, _frameTimeMs?: number): void {}

  writeSegmentBoundary(): void {}
  getCurrentByteOffset(): number { return 0; }
  flush(): void {}
  async stop(): Promise<void> {}
}
/** Capturing WebSocket adapter that records all events. Used in tests. */
export class CapturingWsAdapter implements WsAdapter {
  readonly broadcastedPackets: Array<{ packet: TelemetryPacket; sectors?: LiveSectorData | null; pit?: LivePitData | null; liveIssues?: TuneIssue[] }> = [];
  readonly broadcastedNotifications: Record<string, unknown>[] = [];
  readonly broadcastedDevStates: Record<string, unknown>[] = [];
  readonly stagedDevTelemetry: TelemetryPacket[] = [];
  private readonly capturePackets: boolean;
  readonly wantsDevTelemetry = true;
  readonly wantsDevState = true;
  constructor(capturePackets = true) { this.capturePackets = capturePackets; }
  broadcast(packet: TelemetryPacket, sectors?: LiveSectorData | null, pit?: LivePitData | null, liveIssues?: TuneIssue[]): void {
    if (this.capturePackets) this.broadcastedPackets.push({ packet, sectors, pit, liveIssues });
  }
  stageDevTelemetry(packet: TelemetryPacket): void { this.stagedDevTelemetry.push(packet); }
  publishTelemetry(publication: LiveTelemetryPublication): void {
    this.broadcast(publication.packet, publication.sectors, publication.pit, publication.liveIssues);
  }
  broadcastNotification(event: Record<string, unknown>): void { this.broadcastedNotifications.push(event); }
  broadcastDevState(state: Record<string, unknown>): void { this.broadcastedDevStates.push(state); }
}
