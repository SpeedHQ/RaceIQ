import { invalidateParserDriverEvidence, parsePacket } from "@raceiq/backend-core/games/packet-dispatch";
import { invalidateNativeBindingCandidates, processPacket } from "@raceiq/backend-core/telemetry/live-pipeline";
import { getRecordingFrequencyHz } from "@raceiq/backend-core/runtime/config/recording-frequency";
import { NativeCaptureRateLimiter } from "@raceiq/backend-core/games/shared/native-capture-rate-limiter";
import {
  acquireHighResolutionTimer,
  releaseHighResolutionTimer,
} from "@raceiq/backend-core/games/shared/win-timer-resolution";
import { LMUSharedMemoryReader } from "./memory-reader";
import { identityFromLMUSourceFrame } from "./normalizer";
import { lmuRecorder, type LMURecorderContract } from "./recorder";
import {
  decodeLMUSourceFrame,
  encodeLMUSourceFrame,
  type LMUIdentity,
} from "@raceiq/capture-formats/lmu/source-frame";
import { LMU_SCORING_INFO, LMU_SCORING_VEHICLE, LMU_TELEMETRY } from "@raceiq/capture-formats/lmu/layout";

export interface LMUFrameReader {
  start(): void;
  stop(): Promise<void>;
  readLatest(): Buffer | null;
}

export interface LMUTelemetrySourceOptions {
  reader?: LMUFrameReader;
  dispatchRawFrame?: (rawFrame: Buffer, frameTimeMs?: number) => Promise<void>;
  pollIntervalMs?: number;
  recordingEnabled?: boolean;
  recordingDir?: string;
  recorder?: LMURecorderContract;
}

interface QueuedLMUFrame {
  rawFrame: Buffer;
  frameTimeMs: number;
  identity?: LMUIdentity;
  identityKey: string;
  resolve: (accepted: boolean) => void;
}

async function dispatchThroughParser(rawFrame: Buffer, frameTimeMs?: number): Promise<void> {
  const packet = parsePacket(rawFrame, frameTimeMs);
  if (packet?.IsRaceOn) {
    await processPacket(packet, rawFrame, frameTimeMs);
  }
}

/** Polls LMU_Data and publishes compact frames through RaceIQ parser pipeline. */
export class LMUTelemetrySource {
  private readonly reader: LMUFrameReader;
  private readonly dispatchRawFrame: (rawFrame: Buffer, frameTimeMs?: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly recordingEnabled: boolean;
  private readonly recordingDir: string | undefined;
  private readonly recorder: LMURecorderContract;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private frameQueue: QueuedLMUFrame[] = [];
  private drainPromise: Promise<void> | null = null;
  private holdsTimerResolution = false;
  private readonly captureRateLimiter = new NativeCaptureRateLimiter();
  private lastFrameKey = "";
  private queuedIdentityKey = "";
  private activeIdentityKey = "";
  private identity: LMUIdentity | null = null;
  private lastErrorLogAt = 0;
  private nativeControl: { role: number | null; realtime: boolean; player: boolean; fresh: boolean;
    gameVersion: number; sessionEvent: number; sessionOrdinal: number; vehicleId: number; elapsedTime: number } | null = null;

  constructor(options: LMUTelemetrySourceOptions = {}) {
    this.reader = options.reader ?? new LMUSharedMemoryReader();
    this.dispatchRawFrame = options.dispatchRawFrame ?? dispatchThroughParser;
    this.pollIntervalMs = options.pollIntervalMs ?? 10;
    this.recordingEnabled = options.recordingEnabled ?? false;
    this.recordingDir = options.recordingDir;
    this.recorder = options.recorder ?? lmuRecorder;
  }

  get currentIdentity(): LMUIdentity | null {
    return this.identity;
  }

  start(): void {
    if (this.running) return;
    this.queuedIdentityKey = "";
    this.activeIdentityKey = "";
    this.identity = null;
    this.captureRateLimiter.reset();
    if (this.recordingEnabled && !this.recorder.recording) {
      const path = this.recorder.start(this.recordingDir);
      console.log(`[LMU] Recording mode: bin file created at ${path}`);
    }
    this.reader.start();
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.captureRateLimiter.shouldCapture(performance.now(), getRecordingFrequencyHz())) return;
      void this.pollOnce();
    }, this.pollIntervalMs);
    console.log(
      "[LMU] Telemetry source started; enable Gameplay > Enable Plugins in LMU",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    invalidateParserDriverEvidence("lmu", Date.now());
    this.nativeControl = null;
    this.captureRateLimiter.reset();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.holdsTimerResolution) {
      this.holdsTimerResolution = false;
      releaseHighResolutionTimer();
    }
    try {
      await this.reader.stop();
      await this.drainPromise;
    } finally {
      if (this.recordingEnabled) await this.recorder.stop();
      this.frameQueue = [];
      this.drainPromise = null;
      this.lastFrameKey = "";
      this.queuedIdentityKey = "";
      this.activeIdentityKey = "";
      this.identity = null;
      console.log("[LMU] Telemetry source stopped");
    }
  }

  async pollOnce(): Promise<boolean> {
    try {
      const sharedMemory = this.reader.readLatest();
      if (!sharedMemory) return false;
      const frameTimeMs = Date.now();
      const rawFrame = encodeLMUSourceFrame(sharedMemory, frameTimeMs);
      if (!rawFrame) return false;
      const frame = decodeLMUSourceFrame(rawFrame);
      if (!frame) return false;
      if (this.running && !this.holdsTimerResolution) {
        acquireHighResolutionTimer();
        this.holdsTimerResolution = true;
      }
      const elapsedTime = frame.telemetry.readDoubleLE(LMU_TELEMETRY.elapsedTime);
      const scoringTime = frame.scoringInfo.readDoubleLE(LMU_SCORING_INFO.currentElapsedTime);
      const role = frame.playerScoring?.readInt8(LMU_SCORING_VEHICLE.mControl) ?? null;
      const player = frame.playerScoring?.readUInt8(LMU_SCORING_VEHICLE.isPlayer) === 1;
      const realtime = frame.scoringInfo.readUInt8(LMU_SCORING_INFO.inRealtime) !== 0;
      const fresh = Number.isFinite(elapsedTime) && elapsedTime >= 0 && Number.isFinite(scoringTime) &&
        scoringTime >= 0 && scoringTime <= elapsedTime && (elapsedTime - scoringTime) * 1000 <= 2_000;
      const sessionOrdinal = frame.scoringInfo.readInt32LE(LMU_SCORING_INFO.session);
      const vehicleId = frame.telemetry.readInt32LE(LMU_TELEMETRY.id);
      const previous = this.nativeControl;
      if (!previous || previous.role !== role || previous.player !== player || previous.realtime !== realtime ||
        previous.fresh !== fresh || previous.gameVersion !== frame.gameVersion || previous.sessionEvent !== frame.sessionEvent ||
        previous.sessionOrdinal !== sessionOrdinal || previous.vehicleId !== vehicleId || elapsedTime < previous.elapsedTime) {
        invalidateNativeBindingCandidates("lmu", frameTimeMs);
        if (!realtime && previous?.realtime !== false) invalidateParserDriverEvidence("lmu", frameTimeMs);
        this.nativeControl = { role, player, realtime, fresh, gameVersion: frame.gameVersion,
          sessionEvent: frame.sessionEvent, sessionOrdinal, vehicleId, elapsedTime };
      } else previous.elapsedTime = elapsedTime;
      const frameKey = `${frame.gameVersion}:${frame.sessionEvent}:${sessionOrdinal}:${vehicleId}:${elapsedTime}:${role}:${player}:${realtime}:${fresh}`;
      if (frameKey === this.lastFrameKey) return false;
      this.lastFrameKey = frameKey;

      const identity = identityFromLMUSourceFrame(frame);
      const identityKey = `${identity.carId}\0${identity.trackId}`;
      const changedIdentity = identityKey === this.queuedIdentityKey ? undefined : identity;
      this.queuedIdentityKey = identityKey;
      return await new Promise<boolean>((resolve) => {
        this.frameQueue.push({ rawFrame, frameTimeMs, identity: changedIdentity, identityKey, resolve });
        this.ensureDrain();
      });
    } catch (error) {
      this.logFrameFailure(error);
      return false;
    }
  }

  private ensureDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drainQueue().finally(() => {
      this.drainPromise = null;
      if (this.frameQueue.length > 0) this.ensureDrain();
    });
  }

  private async drainQueue(): Promise<void> {
    while (this.frameQueue.length > 0) {
      const entry = this.frameQueue.shift()!;
      try {
        if (entry.identity && entry.identityKey !== this.activeIdentityKey) {
          this.identity = entry.identity;
          this.activeIdentityKey = entry.identityKey;
        }
        if (this.recordingEnabled) this.recorder.writeFrame(entry.rawFrame);
        await this.dispatchRawFrame(entry.rawFrame, entry.frameTimeMs);
        entry.resolve(true);
      } catch (error) {
        this.logFrameFailure(error);
        entry.resolve(false);
      }
    }
  }

  private logFrameFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 5_000) return;
    this.lastErrorLogAt = now;
    console.error(
      "[LMU] Telemetry source frame failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
