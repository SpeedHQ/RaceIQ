import { LmuOpponentIdentityTracker } from "@raceiq/capture-formats/lmu/opponent-snapshot";
import { randomUUID } from "node:crypto";
import { parsePacket } from "@raceiq/backend-core/games/packet-dispatch";
import { processPacket } from "@raceiq/backend-core/telemetry/live-pipeline";
import { wsManager } from "@raceiq/backend-core/runtime/websocket-manager";
import { getRecordingFrequencyHz } from "@raceiq/backend-core/runtime/config/recording-frequency";
import { NativeCaptureRateLimiter } from "@raceiq/backend-core/games/shared/native-capture-rate-limiter";
import { acquireHighResolutionTimer, releaseHighResolutionTimer } from "@raceiq/backend-core/games/shared/win-timer-resolution";
import { LMUSharedMemoryReader } from "./memory-reader";
import { identityFromLMUSourceFrame } from "./normalizer";
import { lmuRecorder, type LMURecorderContract } from "./recorder";
import { LmuSupplementalRest, type LmuRestOptions } from "./supplemental-rest";
import { decodeLMUSourceFrame, encodeLMUSourceFrame, encodeLMUScoringSourceFrame, type LMUIdentity } from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_MAX_VEHICLES, LMU_SHARED_MEMORY_SIZE, LMU_TELEMETRY_HEADER_OFFSET, LMU_TELEMETRY_INFO_OFFSET, LMU_TELEMETRY_INFO_SIZE, LMU_TELEMETRY, LMU_SCORING_INFO_OFFSET, LMU_SCORING_INFO, LMU_SCORING_VEHICLES_OFFSET, LMU_SCORING_VEHICLE_SIZE, LMU_SCORING_VEHICLE, LMU_SESSION_EVENT_OFFSET } from "@raceiq/capture-formats/lmu/layout";
import type { LmuLiveContext } from "@raceiq/shared/telemetry/lmu";

export interface LMUFrameReader { start(): void; stop(): Promise<void>; readLatest(): Buffer | null; }
export interface LMUTelemetrySourceOptions {
  reader?: LMUFrameReader;
  dispatchRawFrame?: (rawFrame: Buffer, frameTimeMs?: number) => Promise<void>;
  publishUnavailable?: (context: LmuLiveContext) => void;
  publishScoringContext?: (context: LmuLiveContext) => void;
  pollIntervalMs?: number;
  recordingEnabled?: boolean;
  recordingDir?: string;
  recorder?: LMURecorderContract;
  rest?: LmuRestOptions | false;
}
interface QueuedLMUFrame { rawFrame: Buffer; frameTimeMs: number; identity: LMUIdentity | null; scoringContext?: LmuLiveContext; resolve: (accepted: boolean) => void; }
async function dispatchThroughParser(rawFrame: Buffer, frameTimeMs?: number): Promise<void> {
  const packet = parsePacket(rawFrame, frameTimeMs);
  if (packet?.IsRaceOn) await processPacket(packet, rawFrame, frameTimeMs);
}
function opponentGeneration(memory: Buffer, runKey: string): string {
  return `${runKey}:${memory.readUInt32LE(LMU_SESSION_EVENT_OFFSET)}:${memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.session)}:${memory.subarray(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackName, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackName + 64).toString("hex")}`;
}

/** Ordered native capture with independently acquired player/session supplements. */
export class LMUTelemetrySource {
  private readonly reader: LMUFrameReader;
  private readonly dispatchRawFrame: (rawFrame: Buffer, frameTimeMs?: number) => Promise<void>;
  private readonly publishUnavailable: (context: LmuLiveContext) => void;
  private readonly publishScoringContext: (context: LmuLiveContext) => void;
  private readonly pollIntervalMs: number;
  private readonly recordingEnabled: boolean;
  private readonly recordingDir: string | undefined;
  private readonly recorder: LMURecorderContract;
  private readonly rest: LmuSupplementalRest | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pollInProgress = false;
  private frameQueue: QueuedLMUFrame[] = [];
  private drainPromise: Promise<void> | null = null;
  private holdsTimerResolution = false;
  private readonly captureRateLimiter = new NativeCaptureRateLimiter();
  private lastFrameKey = "";
  private identity: LMUIdentity | null = null;
  private lastErrorLogAt = 0;
  private runKey = randomUUID();
  private generation = 0;
  private sequence = 0n;
  private nativeIdentity = "";
  private lastElapsed = -1;
  private lastScoringElapsed = -1;
  private lastNativeUpdateAt = 0;
  private context: LmuLiveContext | null = null;
  private scoringOnlyContext = false;
  private admittedOpponentGeneration: string | null = null;
  private warnedUnadmittedScoringOnly = false;
  private readonly opponentIdentityTracker = new LmuOpponentIdentityTracker();

  constructor(options: LMUTelemetrySourceOptions = {}) {
    this.reader = options.reader ?? new LMUSharedMemoryReader();
    this.dispatchRawFrame = options.dispatchRawFrame ?? dispatchThroughParser;
    this.publishUnavailable = options.publishUnavailable ?? ((context) => wsManager.invalidateLmuTelemetry(context));
    this.publishScoringContext = options.publishScoringContext ?? ((context) => wsManager.publishLmuContext(context));
    this.pollIntervalMs = options.pollIntervalMs ?? 10;
    this.recordingEnabled = options.recordingEnabled ?? false;
    this.recordingDir = options.recordingDir;
    this.recorder = options.recorder ?? lmuRecorder;
    this.rest = options.rest === false ? null : new LmuSupplementalRest(options.rest);
  }
  get currentIdentity(): LMUIdentity | null { return this.context ? this.identity : null; }

  start(): void {
    if (this.running) return;
    this.runKey = randomUUID();
    this.opponentIdentityTracker.reset();
    this.admittedOpponentGeneration = null;
    this.warnedUnadmittedScoringOnly = false;
    this.nativeIdentity = "";
    this.lastFrameKey = "";
    this.lastElapsed = -1;
    this.lastScoringElapsed = -1;
    this.identity = null;
    this.captureRateLimiter.reset();
    if (this.recordingEnabled && !this.recorder.recording) this.recorder.start(this.recordingDir);
    this.reader.start();
    this.running = true;
    this.timer = setInterval(async () => {
      // Diagnostic acquisition must not queue snapshots faster than disk can accept them.
      if (this.recordingEnabled && this.pollInProgress) return;
      if (!this.captureRateLimiter.shouldCapture(performance.now(), getRecordingFrequencyHz())) return;
      this.pollInProgress = true;
      try { await this.pollOnce(); }
      finally { this.pollInProgress = false; }
    }, this.pollIntervalMs);
    console.log("[LMU] Telemetry source started; enable Gameplay > Enable Plugins in LMU");
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    this.captureRateLimiter.reset();
    const invalidation = this.invalidate();
    if (this.holdsTimerResolution) { this.holdsTimerResolution = false; releaseHighResolutionTimer(); }
    try { await this.reader.stop(); await this.drainPromise; await invalidation; }
    finally {
      this.rest?.stop();
      if (this.recordingEnabled) await this.recorder.stop();
      this.frameQueue = [];
      this.drainPromise = null;
      this.lastFrameKey = "";
      this.identity = null;
      console.log("[LMU] Telemetry source stopped");
    }
  }

  async pollOnce(): Promise<boolean> {
    try {
      const memory = this.reader.readLatest();
      const now = Date.now();
      const monotonicNow = performance.now();
      if (!memory || memory.length < LMU_SHARED_MEMORY_SIZE) {
        if (monotonicNow - this.lastNativeUpdateAt > 1000) await this.invalidate();
        return false;
      }
      const count = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET);
      const slot = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 1);
      const playerHasVehicle = memory.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 2) !== 0;
      if (count > LMU_MAX_VEHICLES || (playerHasVehicle && (count < 1 || slot >= count)) || !memory.readUInt8(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.inRealtime) || memory.readUInt8(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.gamePhase) === 9) { await this.invalidate(); return false; }
      if (!playerHasVehicle) return await this.publishScoringSnapshot(memory, now, monotonicNow);
      const t = LMU_TELEMETRY_INFO_OFFSET + slot * LMU_TELEMETRY_INFO_SIZE;
      const vehicleId = memory.readInt32LE(t + LMU_TELEMETRY.id);
      let telemetryMatches = 0;
      for (let index = 0; index < count; index++) {
        if (memory.readInt32LE(LMU_TELEMETRY_INFO_OFFSET + index * LMU_TELEMETRY_INFO_SIZE + LMU_TELEMETRY.id) === vehicleId) telemetryMatches++;
      }
      if (telemetryMatches !== 1) { await this.invalidate(); return false; }
      const scoringCount = memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
      let players = 0;
      let matches = 0;
      let markedId: number | null = null;
      let inGarageStall = false;
      if (scoringCount < 0 || scoringCount > LMU_MAX_VEHICLES || vehicleId < 0) { await this.invalidate(); return false; }
      for (let index = 0; index < scoringCount; index++) {
        const offset = LMU_SCORING_VEHICLES_OFFSET + index * LMU_SCORING_VEHICLE_SIZE;
        const id = memory.readInt32LE(offset + LMU_SCORING_VEHICLE.id);
        if (id === vehicleId) matches++;
        if (memory.readUInt8(offset + LMU_SCORING_VEHICLE.isPlayer)) { players++; markedId = id; inGarageStall = memory.readUInt8(offset + LMU_SCORING_VEHICLE.inGarageStall) !== 0; }
      }
      if (players !== 1 || matches !== 1 || markedId !== vehicleId || inGarageStall) { await this.invalidate(); return false; }
      const elapsed = memory.readDoubleLE(t + LMU_TELEMETRY.elapsedTime);
      const scoringElapsed = memory.readDoubleLE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
      if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(scoringElapsed) || scoringElapsed < 0) { await this.invalidate(); return false; }
      const nativeIdentity = `${memory.readUInt32LE(LMU_SESSION_EVENT_OFFSET)}:${memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.session)}:${vehicleId}:${slot}:${memory.subarray(t + LMU_TELEMETRY.vehicleName, t + LMU_TELEMETRY.trackName + 64).toString("hex")}`;
      // Reader snapshots are reusable: do not yield between validation and encoding.
      if (this.context && (nativeIdentity !== this.nativeIdentity || elapsed < this.lastElapsed || scoringElapsed < this.lastScoringElapsed)) await this.invalidate();
      if (elapsed !== this.lastElapsed) this.lastNativeUpdateAt = monotonicNow;
      else if (monotonicNow - this.lastNativeUpdateAt > 1000) { await this.invalidate(); return false; }
      this.lastElapsed = elapsed;
      this.lastScoringElapsed = scoringElapsed;
      this.scoringOnlyContext = false;
      if (!this.context) {
        this.nativeIdentity = nativeIdentity;
        this.context = { schemaVersion: 1, key: { sessionKey: `${this.runKey}:${++this.generation}`, captureSequence: "0", frameTime: { domain: "session", milliseconds: elapsed * 1000 } }, playerVehicleId: vehicleId, status: "active", supplemental: [] };
        if (this.running) this.rest?.activate({ sessionKey: this.context.key.sessionKey, vehicleId });
      }
      const frameKey = `${this.context.key.sessionKey}:${elapsed}:${scoringElapsed}:${this.rest?.revision ?? 0}`;
      if (frameKey === this.lastFrameKey) return false;
      const captureSequence = this.sequence + 1n;
      const competitors = this.opponentIdentityTracker.snapshot(memory, opponentGeneration(memory, this.runKey), captureSequence, vehicleId);
      if (!competitors) { await this.invalidate(); return false; }
      this.lastFrameKey = frameKey;
      this.sequence = captureSequence;
      this.context = { ...this.context, key: { ...this.context.key, captureSequence: captureSequence.toString(), frameTime: { domain: "session", milliseconds: elapsed * 1000 } }, competitors, supplemental: this.rest?.snapshot() ?? [] };
      const rawFrame = encodeLMUSourceFrame(memory, now, { context: this.context });
      if (!rawFrame) return false;
      const frame = decodeLMUSourceFrame(rawFrame);
      if (!frame) return false;
      this.admittedOpponentGeneration = opponentGeneration(memory, this.runKey);
      if (this.running && !this.holdsTimerResolution) { acquireHighResolutionTimer(); this.holdsTimerResolution = true; }
      const identity = identityFromLMUSourceFrame(frame);
      const pending = Promise.withResolvers<boolean>();
      this.frameQueue.push({ rawFrame, frameTimeMs: now, identity, resolve: pending.resolve });
      this.ensureDrain();
      return await pending.promise;
    } catch (error) { this.logFrameFailure(error); return false; }
  }

  private async publishScoringSnapshot(memory: Buffer, now: number, monotonicNow: number): Promise<boolean> {
    const scoringElapsed = memory.readDoubleLE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.currentElapsedTime);
    if (!Number.isFinite(scoringElapsed) || scoringElapsed < 0) { await this.invalidate(); return false; }
    if (scoringElapsed !== this.lastScoringElapsed) this.lastNativeUpdateAt = monotonicNow;
    else if (monotonicNow - this.lastNativeUpdateAt > 1000) { await this.invalidate(); return false; }
    if (this.lastScoringElapsed >= 0 && scoringElapsed < this.lastScoringElapsed) await this.invalidate();
    this.lastScoringElapsed = scoringElapsed;
    const scoringCount = memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles);
    if (scoringCount < 0 || scoringCount > LMU_MAX_VEHICLES) { await this.invalidate(); return false; }
    let playerVehicleId: number | null = null;
    for (let index = 0; index < scoringCount; index++) {
      const offset = LMU_SCORING_VEHICLES_OFFSET + index * LMU_SCORING_VEHICLE_SIZE;
      if (memory.readUInt8(offset + LMU_SCORING_VEHICLE.isPlayer)) {
        if (playerVehicleId !== null) { await this.invalidate(); return false; }
        playerVehicleId = memory.readInt32LE(offset + LMU_SCORING_VEHICLE.id);
      }
    }
    const sessionIdentity = `${memory.readUInt32LE(LMU_SESSION_EVENT_OFFSET)}:${memory.readInt32LE(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.session)}:${memory.subarray(LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackName, LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.trackName + 64).toString("hex")}`;
    if (this.context && (this.nativeIdentity !== sessionIdentity || scoringElapsed < this.lastScoringElapsed)) await this.invalidate();
    if (!this.context) {
      this.nativeIdentity = sessionIdentity;
      this.context = { schemaVersion: 1, key: { sessionKey: `${this.runKey}:${++this.generation}`, captureSequence: "0", frameTime: { domain: "session", milliseconds: scoringElapsed * 1000 } }, playerVehicleId, status: "active", supplemental: [] };
    }
    const frameKey = `${this.context.key.sessionKey}:${scoringElapsed}`;
    if (frameKey === this.lastFrameKey) return false;
    const captureSequence = this.sequence + 1n;
    const competitors = this.opponentIdentityTracker.snapshot(memory, opponentGeneration(memory, this.runKey), captureSequence, playerVehicleId);
    if (!competitors) { await this.invalidate(); return false; }
    this.lastFrameKey = frameKey;
    this.sequence = captureSequence;
    this.context = { ...this.context, playerVehicleId, competitors, key: { ...this.context.key, captureSequence: captureSequence.toString(), frameTime: { domain: "session", milliseconds: scoringElapsed * 1000 } }, status: "active", supplemental: [] };
    this.scoringOnlyContext = true;
    this.identity = null;
    const sessionGeneration = opponentGeneration(memory, this.runKey);
    if (playerVehicleId === null && this.admittedOpponentGeneration === sessionGeneration) {
      const rawFrame = encodeLMUScoringSourceFrame(memory, now, { context: this.context });
      if (!rawFrame) { await this.invalidate(); return false; }
      const pending = Promise.withResolvers<boolean>();
      this.frameQueue.push({ rawFrame, frameTimeMs: now, identity: null, scoringContext: this.context, resolve: pending.resolve });
      this.ensureDrain();
      return await pending.promise;
    }
    if (this.recordingEnabled && !this.warnedUnadmittedScoringOnly) {
      this.warnedUnadmittedScoringOnly = true;
      console.warn("[LMU] Scoring-only snapshots are live; recording unavailable until a player session is admitted");
    }
    this.publishScoringContext(this.context);
    return true;
  }

  private async invalidate(): Promise<void> {
    const previous = this.context;
    if (!previous) return;
    const scoringOnly = this.scoringOnlyContext;
    this.context = null;
    this.scoringOnlyContext = false;
    this.identity = null;
    this.lastFrameKey = "";
    this.nativeIdentity = "";
    this.lastElapsed = -1;
    this.lastScoringElapsed = -1;
    this.lastNativeUpdateAt = 0;
    this.rest?.stop();
    const generation = this.generation;
    await this.drainPromise;
    if (generation === this.generation && !this.context) {
      const { competitors: _competitors, ...previousContext } = previous;
      const unavailable: LmuLiveContext = { ...previousContext, playerVehicleId: null, status: "unavailable", supplemental: [], key: { ...previous.key, captureSequence: (++this.sequence).toString(), frameTime: { domain: "wall-clock", milliseconds: Date.now() } } };
      if (scoringOnly) this.publishScoringContext(unavailable);
      else this.publishUnavailable(unavailable);
    }
  }
  private ensureDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drainQueue().finally(() => { this.drainPromise = null; if (this.frameQueue.length) this.ensureDrain(); });
  }
  private async drainQueue(): Promise<void> {
    while (this.frameQueue.length) {
      const entry = this.frameQueue.shift()!;
      try {
        this.identity = entry.identity;
        if (this.recordingEnabled) await this.recorder.writeFrame(entry.rawFrame);
        await this.dispatchRawFrame(entry.rawFrame, entry.frameTimeMs);
        if (entry.scoringContext) this.publishScoringContext(entry.scoringContext);
        entry.resolve(true);
      } catch (error) { this.logFrameFailure(error); entry.resolve(false); }
    }
  }
  private logFrameFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 5000) return;
    this.lastErrorLogAt = now;
    console.error("[LMU] Telemetry source frame failed:", error instanceof Error ? error.message : error);
  }
}
