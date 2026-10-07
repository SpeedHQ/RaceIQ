import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getKunosLapResetEvidence, isKunosCompletedLapReset, isKunosPreLapTimerReset, kunosFirstPacketIsMidLap } from "./kunos-policy";

export interface KunosLapCapture {
  processorSessionKey: number;
  packets: TelemetryPacket[];
  trigger?: TelemetryPacket;
  lapNumber: number;
  lapTime: number;
  byteOffset: number | null;
  frameCount: number;
  silent: boolean;
}

export interface KunosEngineOptions {
  createSession(packet: TelemetryPacket): Promise<void>;
  onSessionStarted?(packet: TelemetryPacket): void | Promise<void>;
  backfillSessionIdentifiers(packet: TelemetryPacket): void | Promise<void>;
  isPitOnly(packets: readonly TelemetryPacket[]): boolean;
  emitLap(capture: KunosLapCapture): Promise<void>;
  now?(): number;
}

/** Instance-local ACC/AC Evo transition and capture state. Host effects remain callbacks. */
export class KunosDetectorEngine {
  private readonly options: KunosEngineOptions;
  private sessionSequence = 0;
  private sessionKey: number | null = null;
  private lapBuffer: TelemetryPacket[] = [];
  private currentLapNumber = -1;
  private peakCurrentLap = 0;
  private firstLapIsPartial = false;
  private lastEmittedLapNumber = -1;
  private lapByteOffset: number | null = null;
  private lapFrameCount = 0;
  private currentRawByteOffset: number | null = null;
  private lastActivePacketTime = 0;

  constructor(options: KunosEngineOptions) { this.options = options; }
  get isActive(): boolean { return this.sessionKey !== null; }
  setCurrentLapByteOffset(offset: number): void {
    this.lapByteOffset = offset; this.currentRawByteOffset = offset; this.lapFrameCount = 1;
  }
  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    this.lastActivePacketTime = (this.options.now ?? Date.now)();
    if (rawByteOffset !== undefined) {
      if (this.currentRawByteOffset === null) this.lapByteOffset = rawByteOffset;
      this.currentRawByteOffset = rawByteOffset; this.lapFrameCount++;
    }
    if (this.sessionKey === null) {
      await this.options.createSession(packet);
      this.sessionKey = ++this.sessionSequence;
      this.currentLapNumber = (packet.LapNumber ?? 0) > 0 ? packet.LapNumber! : 1;
      this.firstLapIsPartial = kunosFirstPacketIsMidLap(packet);
      this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = 0;
      await this.options.onSessionStarted?.(packet);
    }
    const backfill = this.options.backfillSessionIdentifiers(packet);
    if (backfill) await backfill;
    const prev = this.lapBuffer[this.lapBuffer.length - 1];
    if (prev && packet.DistanceTraveled < prev.DistanceTraveled - 100) {
      this.resetCapture(rawByteOffset); this.lapBuffer.push(packet); this.updatePeak(packet); return;
    }
    if (!prev) { this.lapBuffer.push(packet); this.updatePeak(packet); return; }
    const evidence = getKunosLapResetEvidence(prev, packet, this.currentLapNumber);
    if (isKunosPreLapTimerReset(prev, evidence)) {
      this.lapBuffer = [packet]; this.peakCurrentLap = packet.CurrentLap; this.firstLapIsPartial = false;
      this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = rawByteOffset === undefined ? 0 : 1; return;
    }
    if (isKunosCompletedLapReset(prev, evidence)) {
      if (this.firstLapIsPartial) {
        const distance = (this.lapBuffer[this.lapBuffer.length - 1]?.DistanceTraveled ?? 0) - (this.lapBuffer[0]?.DistanceTraveled ?? 0);
        if (distance < 100 || this.options.isPitOnly(this.lapBuffer)) {
          this.resetCapture(rawByteOffset); this.lapBuffer.push(packet); this.updatePeak(packet); return;
        }
        this.firstLapIsPartial = false;
      }
      await this.emit(false, packet);
    }
    this.lapBuffer.push(packet); this.updatePeak(packet);
  }
  async flushIncompleteLap(): Promise<void> {
    if (!this.isActive || this.lapBuffer.length < 10) return;
    await this.emit(true); this.lapBuffer = []; this.peakCurrentLap = 0;
  }
  async flushStaleLap(): Promise<boolean> {
    if (!this.isActive || !this.lastActivePacketTime || (this.options.now ?? Date.now)() - this.lastActivePacketTime < 10_000) return false;
    await this.finalize(); return true;
  }
  async finalize(): Promise<void> {
    if (this.sessionKey === null) return;
    if (this.lapBuffer.length >= 10) await this.emit(true);
    this.sessionKey = null; this.lapBuffer = []; this.peakCurrentLap = 0; this.firstLapIsPartial = false;
    this.lapByteOffset = null; this.currentRawByteOffset = null; this.lapFrameCount = 0;
    this.lastActivePacketTime = 0; this.lastEmittedLapNumber = -1; this.currentLapNumber = -1;
  }
  private resetCapture(rawByteOffset?: number): void {
    this.lapBuffer = []; this.peakCurrentLap = 0; this.firstLapIsPartial = false;
    this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = rawByteOffset === undefined ? 0 : 1;
  }
  private updatePeak(packet: TelemetryPacket): void { if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap; }
  private async emit(silent: boolean, trigger?: TelemetryPacket): Promise<void> {
    const buffered = this.lapBuffer[this.lapBuffer.length - 1]?.LastLap ?? 0;
    const reported = trigger?.LastLap ?? 0;
    const lapTime = reported > 0 && reported !== buffered ? reported : this.peakCurrentLap;
    const lapNumber = this.currentLapNumber;
    if (lapNumber === this.lastEmittedLapNumber) return;
    this.lastEmittedLapNumber = lapNumber;
    const packets = this.lapBuffer;
    if (trigger) packets.push(trigger);
    const byteOffset = this.lapByteOffset, frameCount = this.lapFrameCount;
    this.lapBuffer = []; this.peakCurrentLap = 0; this.currentLapNumber = lapNumber + 1;
    this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = trigger && this.currentRawByteOffset !== null ? 1 : 0;
    await this.options.emitLap({ processorSessionKey: this.sessionKey!, packets, trigger, lapNumber, lapTime, byteOffset, frameCount, silent });
  }
}
