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
  invalidReason?: string;
}

export interface KunosEngineOptions {
  createSession(packet: TelemetryPacket): Promise<void>;
  onSessionStarted?(packet: TelemetryPacket): void | Promise<void>;
  backfillSessionIdentifiers(packet: TelemetryPacket): void | Promise<void>;
  isPitOnly(packets: readonly TelemetryPacket[]): boolean;
  isOpenRoute?(packet: TelemetryPacket): boolean;
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
  private openRouteActive = false;
  private openRoutePendingFinish = false;
  private openRouteStartNextPacket = false;
  private openRoutePreviousPacket: TelemetryPacket | null = null;

  constructor(options: KunosEngineOptions) { this.options = options; }
  get isActive(): boolean { return this.sessionKey !== null; }
  setCurrentLapByteOffset(offset: number): void {
    this.lapByteOffset = offset; this.currentRawByteOffset = offset; this.lapFrameCount = 1;
  }
  shouldCheckpoint(packet: TelemetryPacket): boolean {
    if (this.sessionKey === null) return true;
    if (this.options.isOpenRoute?.(packet)) {
      const previous = this.openRoutePreviousPacket;
      const timerReset = previous !== null && previous.CurrentLap > 2 && packet.CurrentLap <= 2;
      const validRunning = packet.IsRaceOn === 1 && packet.acc?.isValidLap === true;
      const startCandidate = !this.openRouteActive && validRunning && packet.CurrentLap <= 2
        && (timerReset || previous === null || this.openRouteStartNextPacket);
      if (startCandidate) return true;
      if (this.openRoutePendingFinish && packet.LastLap > 0) return true;
      const previousTimed = this.lapBuffer[this.lapBuffer.length - 1];
      if (previousTimed && packet.DistanceTraveled < previousTimed.DistanceTraveled - 100) return true;
      if (this.openRouteActive && previous !== null && packet.LapNumber > previous.LapNumber) return true;
      return this.openRouteActive && timerReset;
    }
    const prev = this.lapBuffer[this.lapBuffer.length - 1];
    if (!prev) return false;
    if (packet.DistanceTraveled < prev.DistanceTraveled - 100) return true;
    const evidence = getKunosLapResetEvidence(prev, packet, this.currentLapNumber);
    return isKunosPreLapTimerReset(prev, evidence) || isKunosCompletedLapReset(prev, evidence);
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
      this.currentLapNumber = this.options.isOpenRoute?.(packet) ? 1 : (packet.LapNumber ?? 0) > 0 ? packet.LapNumber! : 1;
      this.firstLapIsPartial = kunosFirstPacketIsMidLap(packet);
      this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = 0;
      await this.options.onSessionStarted?.(packet);
    }
    const backfill = this.options.backfillSessionIdentifiers(packet);
    if (backfill) await backfill;
    if (this.options.isOpenRoute?.(packet)) {
      const previous = this.openRoutePreviousPacket;
      this.openRoutePreviousPacket = packet;
      const timerReset = previous !== null && previous.CurrentLap > 2 && packet.CurrentLap <= 2;
      const validRunning = packet.IsRaceOn === 1 && packet.acc?.isValidLap === true;
      if (!this.openRouteActive) {
        const startNext = this.openRouteStartNextPacket;
        this.openRouteStartNextPacket = false;
        if (validRunning && packet.CurrentLap <= 2 && (timerReset || previous === null || startNext)) {
          this.openRouteActive = true;
          this.openRoutePendingFinish = false;
          this.lapBuffer = [packet];
          this.peakCurrentLap = packet.CurrentLap;
          this.lapByteOffset = this.currentRawByteOffset;
          this.lapFrameCount = rawByteOffset === undefined ? 0 : 1;
        } else {
          this.lapBuffer = [];
        }
        return;
      }
      if (this.openRoutePendingFinish) {
        if (packet.LastLap > 0) {
          await this.emit(false, packet, true);
          this.openRouteActive = false;
          this.openRoutePendingFinish = false;
          this.openRouteStartNextPacket = packet.CurrentLap <= 2;
        } else {
          this.lapFrameCount = Math.max(0, this.lapFrameCount - (rawByteOffset === undefined ? 0 : 1));
        }
        return;
      }
      const previousTimed = this.lapBuffer[this.lapBuffer.length - 1];
      if (previousTimed && packet.DistanceTraveled < previousTimed.DistanceTraveled - 100) {
        this.lapFrameCount = Math.max(0, this.lapFrameCount - (rawByteOffset === undefined ? 0 : 1));
        await this.emit(false, undefined, false, "car reset");
        this.openRouteActive = false;
        this.openRoutePendingFinish = false;
        this.openRouteStartNextPacket = validRunning && packet.CurrentLap <= 2;
        return;
      }
      if (previousTimed && packet.LapNumber > previousTimed.LapNumber) {
        if (packet.LastLap > 0) {
          await this.emit(false, packet, true);
          this.openRouteActive = false;
          this.openRouteStartNextPacket = packet.CurrentLap <= 2;
        } else {
          this.lapBuffer.push(packet);
          this.openRoutePendingFinish = true;
        }
        return;
      }
      if (timerReset) {
        this.lapFrameCount = Math.max(0, this.lapFrameCount - (rawByteOffset === undefined ? 0 : 1));
        await this.emit(false, undefined, false, "car reset");
        this.openRouteActive = false;
        this.openRoutePendingFinish = false;
        this.openRouteStartNextPacket = validRunning && packet.CurrentLap <= 2;
        return;
      }
      this.lapBuffer.push(packet);
      this.updatePeak(packet);
      return;
    }
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
    await this.emit(true);
    this.lapBuffer = []; this.peakCurrentLap = 0;
    this.openRouteActive = false; this.openRoutePendingFinish = false; this.openRouteStartNextPacket = false;
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
    this.openRouteActive = false; this.openRoutePendingFinish = false; this.openRouteStartNextPacket = false; this.openRoutePreviousPacket = null;
  }
  private resetCapture(rawByteOffset?: number): void {
    this.lapBuffer = []; this.peakCurrentLap = 0; this.firstLapIsPartial = false;
    this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = rawByteOffset === undefined ? 0 : 1;
  }
  private updatePeak(packet: TelemetryPacket): void { if (packet.CurrentLap > this.peakCurrentLap) this.peakCurrentLap = packet.CurrentLap; }
  private async emit(silent: boolean, trigger?: TelemetryPacket, useReportedTime = false, invalidReason?: string): Promise<void> {
    const buffered = this.lapBuffer[this.lapBuffer.length - 1]?.LastLap ?? 0;
    const reported = trigger?.LastLap ?? 0;
    const lapTime = reported > 0 && (useReportedTime || reported !== buffered) ? reported : this.peakCurrentLap;
    const lapNumber = this.currentLapNumber;
    if (lapNumber === this.lastEmittedLapNumber) return;
    this.lastEmittedLapNumber = lapNumber;
    const packets = this.lapBuffer;
    if (trigger) packets.push(trigger);
    const byteOffset = this.lapByteOffset, frameCount = this.lapFrameCount;
    this.lapBuffer = []; this.peakCurrentLap = 0; this.currentLapNumber = lapNumber + 1;
    this.lapByteOffset = this.currentRawByteOffset; this.lapFrameCount = trigger && this.currentRawByteOffset !== null ? 1 : 0;
    await this.options.emitLap({ processorSessionKey: this.sessionKey!, packets, trigger, lapNumber, lapTime, byteOffset, frameCount, silent, invalidReason });
  }
}
