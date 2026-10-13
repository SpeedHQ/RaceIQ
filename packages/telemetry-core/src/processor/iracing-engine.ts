import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

interface DeferredPacket { packet: TelemetryPacket; rawByteOffset?: number }
export interface IRacingEngineOptions {
  now(): number;
  feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void>;
  flushStaleLap(): Promise<void>;
  finalizeCurrentSession(): Promise<void>;
}

/** iRacing's delayed authoritative LastLap gate. Persistence and lap lifecycle stay host-owned. */
export class IRacingDetectorEngine {
  private sessionKey: string | undefined;
  private physicalLap: number | null = null;
  private skipFirstCompletion = true;
  private completeInitialLapExpected = false;
  private deferred: DeferredPacket[] = [];
  private pendingUnexpectedLap: DeferredPacket | null = null;
  private staleLastLap = 0;
  private peakNativeCurrentLap = 0;
  private lastActivePacketTime = 0;
  private readonly options: IRacingEngineOptions;
  constructor(options: IRacingEngineOptions) {
    this.options = options;
  }
  expectCompleteLapStart(): void { this.completeInitialLapExpected = true; }
  getDebugState(): Record<string, unknown> {
    return { iracingPhysicalLap: this.physicalLap, iracingDeferredPackets: this.deferred.length,
      iracingWaitingForNativeTime: this.deferred.length > 0,
      iracingPendingUnexpectedLap: this.pendingUnexpectedLap?.packet.LapNumber ?? null };
  }
  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    this.lastActivePacketTime = this.options.now();
    if (packet.sessionUID !== this.sessionKey) {
      this.resetGate(packet);
      await this.options.feed(packet, rawByteOffset);
      return;
    }
    if (this.pendingUnexpectedLap) {
      const pending = this.pendingUnexpectedLap;
      this.pendingUnexpectedLap = null;
      if (packet.LapNumber === pending.packet.LapNumber) await this.acceptUnexpectedLap(pending);
    }
    if (this.physicalLap === null) { this.physicalLap = packet.LapNumber; await this.options.feed(packet, rawByteOffset); return; }
    if (packet.LapNumber === this.physicalLap) {
      if (this.deferred.length === 0) { await this.options.feed(packet, rawByteOffset); return; }
      this.defer(packet, rawByteOffset);
      if (this.nativeTimingRolled(packet)) await this.releaseDeferred(packet.LastLap);
      return;
    }
    if (packet.LapNumber !== this.physicalLap + 1) { this.pendingUnexpectedLap = { packet, rawByteOffset }; return; }
    this.physicalLap = packet.LapNumber;
    if (this.skipFirstCompletion) {
      this.skipFirstCompletion = false;
      await this.options.feed({ ...packet, LastLap: 0 }, rawByteOffset);
      return;
    }
    this.deferred = []; this.staleLastLap = packet.LastLap; this.peakNativeCurrentLap = 0;
    this.defer(packet, rawByteOffset);
  }
  async flushStaleLap(): Promise<void> {
    if (this.deferred.length > 0) {
      if (this.options.now() - this.lastActivePacketTime < 10_000) return;
      await this.finalizeCurrentSession(); return;
    }
    await this.options.flushStaleLap();
  }
  async flushIncompleteLap(): Promise<void> {
    if (this.deferred.length === 0) return;
    const lapTime = this.staleLastLap > 0 ? this.staleLastLap : this.deferred[0]?.packet.LastLap ?? 0;
    if (lapTime > 0) await this.releaseDeferred(lapTime); else this.deferred = [];
  }
  async finalizeCurrentSession(): Promise<void> {
    this.deferred = []; this.pendingUnexpectedLap = null; this.sessionKey = undefined;
    this.physicalLap = null; this.skipFirstCompletion = true; this.staleLastLap = 0;
    this.peakNativeCurrentLap = 0; this.lastActivePacketTime = 0;
    await this.options.finalizeCurrentSession();
  }
  private resetGate(packet: TelemetryPacket): void {
    this.sessionKey = packet.sessionUID; this.physicalLap = packet.LapNumber;
    this.skipFirstCompletion = !this.completeInitialLapExpected; this.completeInitialLapExpected = false;
    this.deferred = []; this.pendingUnexpectedLap = null; this.staleLastLap = packet.LastLap;
    this.peakNativeCurrentLap = packet.iracing?.sdkCurrentLapTime ?? 0;
  }
  private defer(packet: TelemetryPacket, rawByteOffset?: number): void {
    this.deferred.push({ packet, rawByteOffset });
    this.peakNativeCurrentLap = Math.max(this.peakNativeCurrentLap, packet.iracing?.sdkCurrentLapTime ?? 0);
  }
  private nativeTimingRolled(packet: TelemetryPacket): boolean {
    const lastLapChanged = packet.LastLap > 0 && Math.abs(packet.LastLap - this.staleLastLap) > 0.000_1;
    const current = packet.iracing?.sdkCurrentLapTime;
    const timerReset = current !== undefined && this.peakNativeCurrentLap > 10 && current < Math.min(5, this.peakNativeCurrentLap * 0.5);
    return lastLapChanged || timerReset;
  }
  private async releaseDeferred(lapTime: number): Promise<void> {
    const [boundary, ...rest] = this.deferred; this.deferred = [];
    if (!boundary) return;
    await this.options.feed({ ...boundary.packet, LastLap: lapTime }, boundary.rawByteOffset);
    for (const entry of rest) await this.options.feed(entry.packet, entry.rawByteOffset);
  }
  private async acceptUnexpectedLap(entry: DeferredPacket): Promise<void> {
    this.deferred = []; this.physicalLap = entry.packet.LapNumber; this.skipFirstCompletion = true;
    await this.options.feed(entry.packet, entry.rawByteOffset);
  }
}
