import { rememberLMUIdentity } from "../../../shared/games/lmu";
import { processPacket } from "../../telemetry/live-pipeline";
import { parsePacket } from "../packet-dispatch";
import {
  acquireHighResolutionTimer,
  releaseHighResolutionTimer,
} from "../shared/win-timer-resolution";
import { LMUSharedMemoryReader } from "./memory-reader";
import { identityFromLMUSourceFrame } from "./normalizer";
import { lmuRecorder, type LMURecorderContract } from "./recorder";
import {
  decodeLMUSourceFrame,
  encodeLMUSourceFrame,
  type LMUIdentity,
} from "./source-frame";

export interface LMUFrameReader {
  start(): void;
  stop(): Promise<void>;
  readLatest(): Buffer | null;
}

export interface LMUTelemetrySourceOptions {
  reader?: LMUFrameReader;
  dispatchRawFrame?: (rawFrame: Buffer) => Promise<void>;
  registerIdentity?: (identity: LMUIdentity) => Promise<void>;
  pollIntervalMs?: number;
  recordingEnabled?: boolean;
  recordingDir?: string;
  recorder?: LMURecorderContract;
}

async function dispatchThroughParser(rawFrame: Buffer): Promise<void> {
  const packet = parsePacket(rawFrame);
  if (packet?.IsRaceOn) {
    await processPacket(packet, rawFrame);
  }
}

/** Polls LMU_Data and publishes compact frames through RaceIQ parser pipeline. */
export class LMUTelemetrySource {
  private readonly reader: LMUFrameReader;
  private readonly dispatchRawFrame: (rawFrame: Buffer) => Promise<void>;
  private readonly registerIdentity:
    | ((identity: LMUIdentity) => Promise<void>)
    | undefined;
  private readonly pollIntervalMs: number;
  private readonly recordingEnabled: boolean;
  private readonly recordingDir: string | undefined;
  private readonly recorder: LMURecorderContract;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private holdsTimerResolution = false;
  private lastFrameKey = "";
  private lastIdentityKey = "";
  private lastErrorLogAt = 0;

  constructor(options: LMUTelemetrySourceOptions = {}) {
    this.reader = options.reader ?? new LMUSharedMemoryReader();
    this.dispatchRawFrame = options.dispatchRawFrame ?? dispatchThroughParser;
    this.registerIdentity = options.registerIdentity;
    this.pollIntervalMs = options.pollIntervalMs ?? 10;
    this.recordingEnabled = options.recordingEnabled ?? false;
    this.recordingDir = options.recordingDir;
    this.recorder = options.recorder ?? lmuRecorder;
  }

  start(): void {
    if (this.running) return;
    if (this.recordingEnabled && !this.recorder.recording) {
      const path = this.recorder.start(this.recordingDir);
      console.log(`[LMU] Recording mode: bin file created at ${path}`);
    }
    this.reader.start();
    this.running = true;
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    console.log(
      "[LMU] Telemetry source started; enable Gameplay > Enable Plugins in LMU",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
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
    } finally {
      if (this.recordingEnabled) await this.recorder.stop();
      this.lastFrameKey = "";
      this.lastIdentityKey = "";
      console.log("[LMU] Telemetry source stopped");
    }
  }

  async pollOnce(): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    try {
      const sharedMemory = this.reader.readLatest();
      if (!sharedMemory) return false;
      const rawFrame = encodeLMUSourceFrame(sharedMemory);
      if (!rawFrame) return false;
      const frame = decodeLMUSourceFrame(rawFrame);
      if (!frame) return false;
      if (this.running && !this.holdsTimerResolution) {
        acquireHighResolutionTimer();
        this.holdsTimerResolution = true;
      }
      const elapsedTime = frame.telemetry.readDoubleLE(12);
      const frameKey = `${frame.sessionEvent}:${elapsedTime}`;
      if (frameKey === this.lastFrameKey) return false;
      this.lastFrameKey = frameKey;

      const identity = identityFromLMUSourceFrame(frame);
      const identityKey = `${identity.carId}:${identity.trackId}`;
      if (identityKey !== this.lastIdentityKey) {
        this.lastIdentityKey = identityKey;
        rememberLMUIdentity(identity);
        await this.registerIdentity?.(identity);
      }
      if (this.recordingEnabled) this.recorder.writeFrame(rawFrame);
      await this.dispatchRawFrame(rawFrame);
      return true;
    } catch (error) {
      const now = Date.now();
      if (now - this.lastErrorLogAt >= 5_000) {
        this.lastErrorLogAt = now;
        console.error(
          "[LMU] Telemetry source frame failed:",
          error instanceof Error ? error.message : error,
        );
      }
      return false;
    } finally {
      this.polling = false;
    }
  }
}
