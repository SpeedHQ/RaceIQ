import { registerDiscoveredCar } from "@raceiq/backend-core/db/discovered-cars";
import { registerDiscoveredTrack } from "@raceiq/backend-core/db/discovered-tracks";
import { processPacket } from "@raceiq/backend-core/telemetry/live-pipeline";
import { parsePacket } from "@raceiq/backend-core/games/packet-dispatch";
import { AMS2SharedMemoryReader } from "./memory-reader";
import { AMS2_LAYOUT as L } from "./layout";
import { encodeAMS2Frame } from "./frame";
import { normalizeAMS2Frame } from "./normalizer";
import { acquireHighResolutionTimer, releaseHighResolutionTimer } from "@raceiq/backend-core/games/shared/win-timer-resolution";
interface FrameReader {start(): void; stop(): Promise<void>; readLatest(): Buffer | null;}
export interface AMS2SourceOptions {reader?: FrameReader; dispatchRawFrame?: (frame: Buffer, time: number) => Promise<void>; pollIntervalMs?: number; registerIdentity?: (packet: import("@raceiq/shared/telemetry/types").TelemetryPacket) => Promise<void>;}
export class AMS2TelemetrySource {
  private readonly reader: FrameReader;
  private readonly dispatch: (frame: Buffer, time: number) => Promise<void>;
  private readonly interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<boolean> | null = null;
  private sequence: number | null = null;
  private epoch = 1;
  private wasInSession = false;
  private lapTime = 0;
  private holdsTimerResolution = false;
  private lastErrorAt = 0;
  private identityKey = "";
  private readonly registerIdentity: NonNullable<AMS2SourceOptions["registerIdentity"]>;
  constructor(options: AMS2SourceOptions = {}) {
    this.reader = options.reader ?? new AMS2SharedMemoryReader();
    this.interval = options.pollIntervalMs ?? 10;
    this.registerIdentity = options.registerIdentity ?? (async packet => {
      if (!packet.ams2) return;
      await registerDiscoveredCar("ams2", packet.CarOrdinal, packet.ams2.carName);
      await registerDiscoveredTrack("ams2", packet.TrackOrdinal, packet.ams2.trackName);
    });
    this.dispatch = options.dispatchRawFrame ?? (async (frame, time) => {
      const packet = parsePacket(frame);
      if (packet) await processPacket(packet, frame, time);
    });
  }
  start(): void {
    if (this.timer) return;
    this.reader.start(); acquireHighResolutionTimer(); this.holdsTimerResolution = true;
    this.timer = setInterval(() => void this.pollOnce(), this.interval);
    console.log("[AMS2] Waiting for telemetry. Set Shared Memory to Project CARS 2 in AMS2.");
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    await this.pending;
    await this.reader.stop();
    if (this.holdsTimerResolution) releaseHighResolutionTimer();
    this.holdsTimerResolution = false; this.sequence = null;
  }
  pollOnce(): Promise<boolean> {
    // Serial dispatch prevents unbounded frame queues when persistence slows.
    if (this.pending) return Promise.resolve(false);
    this.pending = this.poll().finally(() => {this.pending = null;});
    return this.pending;
  }
  private async poll(): Promise<boolean> {
    try {
      const memory = this.reader.readLatest(); if (!memory) {this.sequence = null; return false;}
      const sequence = memory.readUInt32LE(L.mSequenceNumber);
      if ((sequence & 1) || sequence === this.sequence) return false;
      this.sequence = sequence;
      const gameState = memory.readUInt32LE(L.mGameState);
      const inSession = gameState === 2 || gameState === 3 || gameState === 4;
      // Menu snapshots can retain the previous car and track. Do not publish
      // them as live readings after the player leaves the driving session.
      if (!inSession) { this.wasInSession = false; this.lapTime = 0; return false; }
      const time = Date.now();
      let raw = encodeAMS2Frame(memory, time, this.epoch);
      let packet = normalizeAMS2Frame(raw);
      if (!packet) {
        if (Date.now() - this.lastErrorAt > 5000) {
          console.warn(`[AMS2] Snapshot rejected: ABI ${memory.readUInt32LE(L.mVersion)}, game state ${gameState}, participants ${memory.readInt32LE(L.mNumParticipants)}, viewed ${memory.readInt32LE(L.mViewedParticipantIndex)}. Waiting for an active car and track.`);
          this.lastErrorAt = Date.now();
        }
        return false;
      }
      const restarted = this.wasInSession && inSession && packet.LapNumber === 1 && packet.CurrentLap + 1 < this.lapTime && packet.LastLap <= 0;
      if ((!this.wasInSession && inSession) || restarted) {this.epoch++; raw = encodeAMS2Frame(memory,time,this.epoch); packet = normalizeAMS2Frame(raw)!;}
      this.wasInSession = inSession; this.lapTime = packet.CurrentLap;
      const identityKey = `${packet.CarOrdinal}:${packet.TrackOrdinal}`;
      if (identityKey !== this.identityKey) {
        await this.registerIdentity(packet); this.identityKey = identityKey;
        console.log(`[AMS2] Receiving telemetry: ${packet.ams2?.carName} at ${packet.ams2?.trackName}; ABI ${memory.readUInt32LE(L.mVersion)}`);
      }
      await this.dispatch(raw,time); return true;
    } catch(error) {
      if (Date.now()-this.lastErrorAt > 5000) {console.error("[AMS2] Telemetry frame failed:", error); this.lastErrorAt=Date.now();}
      return false;
    }
  }
}
