import { parsePacket } from "../packet-dispatch";
import { processPacket } from "../../telemetry/live-pipeline";
import { IRacingSdkReader, type IRacingSdkSnapshot } from "./sdk-reader";
import { parseIRacingSessionInfo } from "./session-info";
import {
  IRacingSourceFrameEncoder,
  type IRacingSessionSnapshot,
  type IRacingSourceFrameV3,
  type IRacingValue,
} from "./source-frame";
import { iracingRecorder, type IRacingRecorder } from "./recorder";
import {
  DumpToBinProcessor,
  IRacingFramePipeline,
  ParsingProcessor,
} from "./frame-pipeline";
import { acquireHighResolutionTimer, releaseHighResolutionTimer } from "../shared/win-timer-resolution";

export interface IRacingFrameReader {
  start(): void;
  stop(): Promise<void>;
  readLatest(): IRacingSdkSnapshot | null;
}

export interface IRacingTelemetrySourceOptions {
  reader?: IRacingFrameReader;
  dispatchRawFrame?: (rawFrame: Buffer) => Promise<void>;
  registerIdentity?: (session: IRacingSessionSnapshot) => Promise<void>;
  pollIntervalMs?: number;
  recordingEnabled?: boolean;
  recordingDir?: string;
  recorder?: IRacingRecorder;
}

interface QueuedIRacingFrame {
  rawFrame: Buffer;
  identity?: IRacingSessionSnapshot;
  identityKey?: string;
  resolve: (processed: boolean) => void;
}

async function dispatchThroughParser(rawFrame: Buffer): Promise<void> {
  const packet = parsePacket(rawFrame);
  if (packet?.IsRaceOn) {
    await processPacket(packet, rawFrame);
  }
}

function numeric(values: Record<string, IRacingValue>, name: string, fallback = 0): number {
  const value = values[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Owns the iRacing telemetry polling loop and publishes raw frames into the exact
 * parser -> pipeline path used by the UDP games.
 */
export class IRacingTelemetrySource {
  private readonly reader: IRacingFrameReader;
  private readonly dispatchRawFrame: (rawFrame: Buffer) => Promise<void>;
  private readonly registerIdentity:
    | ((session: IRacingSessionSnapshot) => Promise<void>)
    | undefined;
  private readonly pollIntervalMs: number;
  private readonly recordingEnabled: boolean;
  private readonly recordingDir: string | undefined;
  private readonly recorder: IRacingRecorder;
  private readonly frameEncoder = new IRacingSourceFrameEncoder();
  private readonly framePipeline = new IRacingFramePipeline();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastErrorLogAt = 0;
  private holdsTimerResolution = false;
  private cachedSessionInfoUpdate: number | null = null;
  private cachedSessionInfo: string | null = null;
  private cachedSessionNum: number | null = null;
  private cachedSession: IRacingSessionSnapshot | null = null;
  private cachedIdentityKey: string | null = null;
  // SDK retains only its newest row. Capture and encode on every timer tick;
  // serialize slower persistence and pipeline work behind this in-memory queue.
  private readonly frameQueue: QueuedIRacingFrame[] = [];
  private drainPromise: Promise<void> | null = null;

  constructor(options: IRacingTelemetrySourceOptions = {}) {
    this.reader = options.reader ?? new IRacingSdkReader();
    this.dispatchRawFrame = options.dispatchRawFrame ?? dispatchThroughParser;
    this.registerIdentity = options.registerIdentity;
    // Poll above the SDK's 60Hz rate so timer phase and brief processing overlap cannot miss ticks.
    // IRacingSdkReader deduplicates unchanged tick counts.
    this.pollIntervalMs = options.pollIntervalMs ?? 1000 / 240;
    this.recordingEnabled = options.recordingEnabled ?? false;
    this.recordingDir = options.recordingDir;
    this.recorder = options.recorder ?? iracingRecorder;
    if (this.recordingEnabled) {
      this.framePipeline.register(new DumpToBinProcessor(this.recorder));
    }
    this.framePipeline.register(new ParsingProcessor(this.dispatchRawFrame));
  }

  start(): void {
    if (this.running) return;
    if (this.recordingEnabled && !this.recorder.recording) {
      const recordPath = this.recorder.start(this.recordingDir);
      console.log(`[iRacing] Recording mode: bin file created at ${recordPath}`);
    }
    this.reader.start();
    acquireHighResolutionTimer();
    this.holdsTimerResolution = true;
    this.running = true;
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    console.log("[iRacing] Telemetry source started");
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
    let readerStopFailed = false;
    let readerStopError: unknown;
    try {
      await this.reader.stop();
    } catch (error) {
      readerStopFailed = true;
      readerStopError = error;
    }
    try {
      await this.drainPromise;
    } finally {
      if (this.recordingEnabled) {
        await this.recorder.stop();
      }
      this.cachedSessionInfoUpdate = null;
      this.cachedSessionInfo = null;
      this.cachedSessionNum = null;
      this.cachedSession = null;
      this.cachedIdentityKey = null;
      this.frameQueue.length = 0;
      this.drainPromise = null;
      this.frameEncoder.reset();
      console.log("[iRacing] Telemetry source stopped");
    }
    if (readerStopFailed) throw readerStopError;
  }

  async pollOnce(): Promise<boolean> {
    try {
      const snapshot = this.reader.readLatest();
      if (!snapshot) return false;

      const sessionNum = Math.trunc(numeric(snapshot.values, "SessionNum", 0));
      let identity: IRacingSessionSnapshot | undefined;
      if (
        !this.cachedSession ||
        this.cachedSessionInfoUpdate !== snapshot.sessionInfoUpdate ||
        this.cachedSessionInfo !== snapshot.sessionInfo ||
        this.cachedSessionNum !== sessionNum
      ) {
        const session = parseIRacingSessionInfo(
          snapshot.sessionInfo,
          sessionNum,
        );
        this.cachedSessionInfoUpdate = snapshot.sessionInfoUpdate;
        this.cachedSessionInfo = snapshot.sessionInfo;
        this.cachedSessionNum = sessionNum;
        this.cachedSession = session;

        const identityKey = [
          session.carId,
          session.carName,
          session.trackId,
          session.trackName,
        ].join("\0");
        if (identityKey !== this.cachedIdentityKey) {
          this.cachedIdentityKey = identityKey;
          identity = session;
        }
      }
      const frame: IRacingSourceFrameV3 = {
        schemaVersion: 3,
        session: this.cachedSession,
        values: snapshot.values,
        sessionInfo: snapshot.sessionInfo,
        sessionInfoUpdate: snapshot.sessionInfoUpdate,
      };
      const rawFrame = this.frameEncoder.encode(frame);
      return await new Promise<boolean>((resolve) => {
        this.frameQueue.push({
          rawFrame,
          identity,
          identityKey: identity
            ? (this.cachedIdentityKey ?? undefined)
            : undefined,
          resolve,
        });
        this.startDrain();
      });
    } catch (error) {
      this.logSourceError(error);
      return false;
    }
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    const drain = this.drainFrames();
    this.drainPromise = drain;
    void drain
      .finally(() => {
        if (this.drainPromise !== drain) return;
        this.drainPromise = null;
        if (this.frameQueue.length > 0) this.startDrain();
      })
      .catch(() => {});
  }

  private async drainFrames(): Promise<void> {
    let entry: QueuedIRacingFrame | undefined;
    while ((entry = this.frameQueue.shift())) {
      try {
        if (entry.identity) {
          await this.registerIdentity?.(entry.identity);
        }
      } catch (error) {
        if (
          entry.identityKey &&
          entry.identityKey === this.cachedIdentityKey
        ) {
          this.cachedIdentityKey = null;
          this.cachedSessionInfoUpdate = null;
        }
        this.logSourceError(error);
      }

      try {
        await this.framePipeline.process(entry.rawFrame);
        entry.resolve(true);
      } catch (error) {
        this.logSourceError(error);
        entry.resolve(false);
      }
    }
  }

  private logSourceError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 5000) return;
    this.lastErrorLogAt = now;
    console.error(
      "[iRacing] Telemetry source frame failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
