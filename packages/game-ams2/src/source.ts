import { registerDiscoveredCar } from "@raceiq/backend-core/db/discovered-cars";
import { registerDiscoveredTrack } from "@raceiq/backend-core/db/discovered-tracks";
import { processPacket, lapDetector } from "@raceiq/backend-core/telemetry/live-pipeline";
import { parsePacket } from "@raceiq/backend-core/games/packet-dispatch";
import { AMS2SharedMemoryReader, type AMS2ReadDiagnostics } from "./memory-reader";
import { AMS2_LAYOUT as L } from "./layout";
import { encodeAMS2Frame, isAMS2SessionEndFrame } from "./frame";
import { normalizeAMS2Frame } from "./normalizer";
import { AMS2DumpRecorder, type AMS2RecorderContract } from "./recorder";
import { acquireHighResolutionTimer, releaseHighResolutionTimer } from "@raceiq/backend-core/games/shared/win-timer-resolution";
interface FrameReader {
  start(): void;
  stop(): Promise<void>;
  readLatest(): Buffer | null;
  getDiagnostics?(): AMS2ReadDiagnostics;
}
export interface AMS2SourceOptions {
  reader?: FrameReader;
  dispatchRawFrame?: (frame: Buffer, time: number) => Promise<void>;
  pollIntervalMs?: number;
  registerIdentity?: (packet: import("@raceiq/shared/telemetry/types").TelemetryPacket) => Promise<void>;
  recordingEnabled?: boolean;
  recordingDir?: string;
  recorder?: AMS2RecorderContract;
  onSessionEnd?: () => Promise<void>;
}
export class AMS2TelemetrySource {
  private readonly reader: FrameReader;
  private readonly dispatch: (frame: Buffer, time: number) => Promise<void>;
  private readonly interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<boolean> | null = null;
  private sequence: number | null = null;
  private lastMemory: Buffer | null = null;
  private epoch = Date.now() >>> 0;
  private wasInSession = false;
  private lapTime = 0;
  private holdsTimerResolution = false;
  private lastErrorAt = 0;
  private identityKey = "";
  private readonly registerIdentity: NonNullable<AMS2SourceOptions["registerIdentity"]>;
  private readonly recorder: AMS2RecorderContract;
  private readonly options: AMS2SourceOptions;
  private readonly onSessionEnd: () => Promise<void>;
  private lastFlushAt = 0;
  private sessionState: number | null = null;
  private lastDiagnosticAt = 0;
  private readonly diagnostics = {
    polls: 0, processingBusy: 0, noSnapshot: 0, duplicates: 0, writerBusy: 0,
    malformed: 0, staleTransition: 0, dispatched: 0, errors: 0,
  };

  getDiagnostics() { return { ...this.diagnostics, reader: this.reader.getDiagnostics?.() }; }

  private logDiagnostics(force = false): void {
    if (!this.options.recordingEnabled) return;
    const now = Date.now();
    if (!force && now - this.lastDiagnosticAt < 10_000) return;
    this.lastDiagnosticAt = now;
    console.log(`[AMS2] Capture totals: ${JSON.stringify(this.getDiagnostics())}`);
  }
  constructor(options: AMS2SourceOptions = {}) {
    this.options = options;
    this.recorder = options.recorder ?? new AMS2DumpRecorder();
    this.onSessionEnd =
      options.onSessionEnd ??
      (async () => {
        if (lapDetector.session?.gameId === "ams2") await lapDetector.finalizeCurrentSession();
      });
    this.reader = options.reader ?? new AMS2SharedMemoryReader();
    this.interval = options.pollIntervalMs ?? 10;
    this.registerIdentity =
      options.registerIdentity ??
      (async (packet) => {
        if (!packet.ams2) return;
        await registerDiscoveredCar("ams2", packet.carId, packet.ams2.carName);
        await registerDiscoveredTrack("ams2", packet.trackId, packet.ams2.trackName);
      });
    this.dispatch =
      options.dispatchRawFrame ??
      (async (frame, time) => {
        const packet = parsePacket(frame);
        if (packet) await processPacket(packet, frame, time);
      });
  }
  start(): void {
    if (this.timer) return;
    if (this.options.recordingEnabled) {
      console.log(`[AMS2] Recording mode: ${this.recorder.start(this.options.recordingDir)}`);
    }
    this.reader.start();
    acquireHighResolutionTimer();
    this.holdsTimerResolution = true;
    this.timer = setInterval(() => void this.pollOnce(), this.interval);
    console.log("[AMS2] Waiting for telemetry. Set Shared Memory to Project CARS 2 in AMS2.");
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.pending;
      await this.reader.stop();
    } finally {
      if (this.holdsTimerResolution) releaseHighResolutionTimer();
      this.holdsTimerResolution = false;
      this.sequence = null;
      this.lastMemory = null;
      this.wasInSession = false;
      this.identityKey = "";
      this.lapTime = 0;
      this.sessionState = null;
      this.logDiagnostics(true);
      if (this.options.recordingEnabled) await this.recorder.stop();
    }
  }
  pollOnce(): Promise<boolean> {
    // Serial dispatch prevents unbounded frame queues when persistence slows.
    this.diagnostics.polls++;
    this.logDiagnostics();
    if (this.pending) {
      this.diagnostics.processingBusy++;
      return Promise.resolve(false);
    }
    this.pending = this.poll().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async poll(): Promise<boolean> {
    try {
      const memory = this.reader.readLatest();
      const time = Date.now(); // Acquisition UTC, before parsing, copying, or queues.
      if (!memory) {
        this.diagnostics.noSnapshot++;
        this.sequence = null;
        this.lastMemory = null;
        return false;
      }
      const sequence = memory.readUInt32LE(L.mSequenceNumber);
      if (sequence & 1) { this.diagnostics.writerBusy++; return false; }
      if (sequence === this.sequence && this.lastMemory && memory.equals(this.lastMemory)) {
        this.diagnostics.duplicates++;
        return false;
      }
      this.sequence = sequence;
      this.lastMemory = Buffer.from(memory);
      const gameState = memory.readUInt32LE(L.mGameState);
      const inSession = gameState === 2 || gameState === 3 || gameState === 4;
      let raw = encodeAMS2Frame(memory, time, this.epoch);
      // Preserve every accepted source snapshot, including empty menus and replay.
      // Production live telemetry still excludes menu/replay readings.
      const writeDump = (): void => {
        if (!this.options.recordingEnabled) return;
        this.recorder.writeFrame(raw);
        if (time - this.lastFlushAt >= 1000) {
          this.recorder.flush();
          this.lastFlushAt = time;
        }
      };
      // Menu snapshots can retain the previous car and track. Do not publish
      // them as live readings after the player leaves the driving session.
      if (!inSession) {
        writeDump();
        if (this.wasInSession && isAMS2SessionEndFrame(raw)) {
          await this.onSessionEnd();
          this.wasInSession = false;
          this.lapTime = 0;
          this.identityKey = "";
          this.sessionState = null;
        }
        return false;
      }
      let packet = normalizeAMS2Frame(raw);
      if (!packet) {
        this.diagnostics.malformed++;
        writeDump();
        if (Date.now() - this.lastErrorAt > 5000) {
          console.warn(
            `[AMS2] Snapshot rejected: ABI ${memory.readUInt32LE(L.mVersion)}, game state ${gameState}, participants ${memory.readInt32LE(L.mNumParticipants)}, viewed ${memory.readInt32LE(L.mViewedParticipantIndex)}. Waiting for an active car and track.`,
          );
          this.lastErrorAt = Date.now();
        }
        return false;
      }
      const sessionState = memory.readUInt32LE(L.mSessionState);
      // AMS2 briefly changes session type before clearing the previous session's
      // finished timing. Keep those bytes in dumps, but do not open a live session.
      if (this.sessionState !== null && sessionState !== this.sessionState && memory.readUInt32LE(L.mRaceState) === 3) {
        this.diagnostics.staleTransition++;
        writeDump();
        return false;
      }
      this.sessionState = sessionState;
      const restarted = this.wasInSession && inSession && packet.LapNumber === 1 && packet.CurrentLap + 1 < this.lapTime && packet.LastLap <= 0;
      if ((!this.wasInSession && inSession) || restarted) {
        this.epoch = (this.epoch + 1) >>> 0;
        raw = encodeAMS2Frame(memory, time, this.epoch);
        packet = normalizeAMS2Frame(raw)!;
      }
      writeDump();
      this.wasInSession = inSession;
      this.lapTime = packet.CurrentLap;
      const identityKey = `${packet.carId}:${packet.trackId}`;
      if (identityKey !== this.identityKey) {
        await this.registerIdentity(packet);
        this.identityKey = identityKey;
        console.log(`[AMS2] Receiving telemetry: ${packet.ams2?.carName} at ${packet.ams2?.trackName}; ABI ${memory.readUInt32LE(L.mVersion)}`);
      }
      await this.dispatch(raw, time);
      this.diagnostics.dispatched++;
      return true;
    } catch (error) {
      this.diagnostics.errors++;
      if (Date.now() - this.lastErrorAt > 5000) {
        console.error("[AMS2] Telemetry frame failed:", error);
        this.lastErrorAt = Date.now();
      }
      return false;
    }
  }
}
