import { parsePacket } from "../../parsers";
import { processPacket } from "../../pipeline";
import { IRacingSdkReader, type IRacingSdkSnapshot } from "./sdk-reader";
import { parseIRacingSessionInfo } from "./session-info";
import {
  encodeIRacingSourceFrame,
  type IRacingSessionSnapshot,
  type IRacingSourceFrameV1,
  type IRacingValue,
} from "./source-frame";
import { iracingRecorder, type IRacingRecorder } from "./recorder";

export interface IRacingFrameReader {
  start(): void;
  stop(): Promise<void>;
  readLatest(): IRacingSdkSnapshot | null;
}

export interface IRacingTelemetrySourceOptions {
  reader?: IRacingFrameReader;
  dispatchRawFrame?: (rawFrame: Buffer) => Promise<void>;
  pollIntervalMs?: number;
  recordingEnabled?: boolean;
  recordingDir?: string;
  recorder?: IRacingRecorder;
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
  private readonly pollIntervalMs: number;
  private readonly recordingEnabled: boolean;
  private readonly recordingDir: string | undefined;
  private readonly recorder: IRacingRecorder;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private lastErrorLogAt = 0;
  private cachedSessionInfoUpdate: number | null = null;
  private cachedSessionNum: number | null = null;
  private cachedSession: IRacingSessionSnapshot | null = null;

  constructor(options: IRacingTelemetrySourceOptions = {}) {
    this.reader = options.reader ?? new IRacingSdkReader();
    this.dispatchRawFrame = options.dispatchRawFrame ?? dispatchThroughParser;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000 / 60;
    this.recordingEnabled = options.recordingEnabled ?? false;
    this.recordingDir = options.recordingDir;
    this.recorder = options.recorder ?? iracingRecorder;
  }

  start(): void {
    if (this.running) return;
    if (this.recordingEnabled && !this.recorder.recording) {
      const recordPath = this.recorder.start(this.recordingDir);
      console.log(`[iRacing] Recording mode: bin file created at ${recordPath}`);
    }
    this.reader.start();
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
    try {
      await this.reader.stop();
    } finally {
      if (this.recordingEnabled) {
        await this.recorder.stop();
      }
      this.cachedSessionInfoUpdate = null;
      this.cachedSessionNum = null;
      this.cachedSession = null;
      console.log("[iRacing] Telemetry source stopped");
    }
  }

  async pollOnce(): Promise<boolean> {
    if (this.polling) return false;
    this.polling = true;
    try {
      const snapshot = this.reader.readLatest();
      if (!snapshot) return false;

      const sessionNum = Math.trunc(numeric(snapshot.values, "SessionNum", 0));
      if (
        !this.cachedSession ||
        this.cachedSessionInfoUpdate !== snapshot.sessionInfoUpdate ||
        this.cachedSessionNum !== sessionNum
      ) {
        this.cachedSessionInfoUpdate = snapshot.sessionInfoUpdate;
        this.cachedSessionNum = sessionNum;
        this.cachedSession = parseIRacingSessionInfo(
          snapshot.sessionInfo,
          sessionNum,
        );
      }
      const frame: IRacingSourceFrameV1 = {
        schemaVersion: 1,
        session: this.cachedSession,
        values: snapshot.values,
      };
      const rawFrame = encodeIRacingSourceFrame(frame);
      if (this.recordingEnabled) {
        this.recorder.writeFrame(rawFrame);
      }
      await this.dispatchRawFrame(rawFrame);
      return true;
    } catch (error) {
      const now = Date.now();
      if (now - this.lastErrorLogAt >= 5000) {
        this.lastErrorLogAt = now;
        console.error(
          "[iRacing] Telemetry source frame failed:",
          error instanceof Error ? error.message : error,
        );
      }
      return false;
    } finally {
      this.polling = false;
    }
  }
}
