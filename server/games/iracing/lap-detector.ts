import type { TelemetryPacket } from "../../../shared/telemetry/types";
import {
  LapDetector,
  type LapFuelData,
  type LapTireWearData,
  type SessionState,
} from "../../lap-detection/detector";
import type {
  ILapDetector,
  LapDetectorOptions,
  SessionEndReason,
} from "../../lap-detection/types";

export const LAP_DETECTOR_IRACING_ID = "iracing_lapdetector_v5";

interface DeferredPacket {
  packet: TelemetryPacket;
  rawByteOffset?: number;
}

/**
 * iRacing changes `Lap` at the physical start/finish line, then publishes the
 * matching `LastLap` roughly two seconds later. This gate holds only those
 * first next-lap detector inputs. Once the native timer rolls over, it gives
 * the shared detector the original boundary packet with the authoritative lap
 * time and then drains the remaining packets with their original raw offsets.
 *
 * Everything else—session lifecycle, validation, persistence, metrics, fuel
 * and tyre history, callbacks, and incomplete laps—stays in `LapDetector`.
 */
export class LapDetectorIRacing implements ILapDetector {
  readonly detectorId = LAP_DETECTOR_IRACING_ID;

  private readonly detector: LapDetector;
  private sessionKey: string | undefined;
  private physicalLap: number | null = null;
  private skipFirstCompletion = true;
  private deferred: DeferredPacket[] = [];
  private pendingUnexpectedLap: DeferredPacket | null = null;
  private staleLastLap = 0;
  private peakNativeCurrentLap = 0;
  private lastActivePacketTime = 0;

  constructor(options: LapDetectorOptions) {
    // Live iRacing frames are already gated by IsOnTrack. Its SDK source may
    // drain a short queued burst after lap persistence, so wall-clock packet
    // rate is not a valid activity signal and must not drop the lap boundary.
    this.detector = new LapDetector({
      ...options,
      bypassPacketRateFilter: true,
    });
  }

  get session(): SessionState | null {
    return this.detector.session;
  }

  get fuelHistory(): LapFuelData[] {
    return this.detector.fuelHistory;
  }

  get tireWearHistory(): LapTireWearData[] {
    return this.detector.tireWearHistory;
  }

  setCurrentLapByteOffset(offset: number): void {
    this.detector.setCurrentLapByteOffset(offset);
  }

  async feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    this.lastActivePacketTime = Date.now();
    if (packet.sessionUID !== this.sessionKey) {
      this.resetGate(packet);
      await this.detector.feed(packet, rawByteOffset);
      return;
    }

    if (this.pendingUnexpectedLap) {
      const pending = this.pendingUnexpectedLap;
      this.pendingUnexpectedLap = null;
      if (packet.LapNumber === pending.packet.LapNumber) {
        await this.acceptUnexpectedLap(pending);
      }
      // If the source returned to the current lap, the pending packet was a
      // one-frame SDK glitch. Drop it and process this packet normally.
    }

    if (this.physicalLap === null) {
      this.physicalLap = packet.LapNumber;
      await this.detector.feed(packet, rawByteOffset);
      return;
    }

    if (packet.LapNumber === this.physicalLap) {
      if (this.deferred.length === 0) {
        await this.detector.feed(packet, rawByteOffset);
        return;
      }

      this.defer(packet, rawByteOffset);
      if (this.nativeTimingRolled(packet)) {
        await this.releaseDeferred(packet.LastLap);
      }
      return;
    }

    if (packet.LapNumber !== this.physicalLap + 1) {
      // iRacing can publish one zeroed frame between otherwise contiguous
      // packets. Require an unexpected lap transition to persist for two
      // packets before handing restart/rewind/skip handling to the detector.
      this.pendingUnexpectedLap = { packet, rawByteOffset };
      return;
    }

    this.physicalLap = packet.LapNumber;
    if (this.skipFirstCompletion) {
      // The source may attach anywhere around the circuit. Suppress only that
      // initial fragment; all subsequent complete physical laps are retained.
      this.skipFirstCompletion = false;
      await this.detector.feed({ ...packet, LastLap: 0 }, rawByteOffset);
      return;
    }

    this.deferred = [];
    this.staleLastLap = packet.LastLap;
    this.peakNativeCurrentLap = 0;
    this.defer(packet, rawByteOffset);
  }

  async flushStaleLap(): Promise<void> {
    if (this.deferred.length > 0) {
      if (Date.now() - this.lastActivePacketTime < 10_000) return;
      // A physical lap ended but iRacing never published its authoritative
      // timing rollover. Do not turn the sampled CurrentLap peak into a result.
      await this.finalizeCurrentSession("source-stale");
      return;
    }
    await this.detector.flushStaleLap();
  }

  async finalizeCurrentSession(reason: SessionEndReason = "source-disconnected"): Promise<void> {
    this.deferred = [];
    this.pendingUnexpectedLap = null;
    this.sessionKey = undefined;
    this.physicalLap = null;
    this.skipFirstCompletion = true;
    this.staleLastLap = 0;
    this.peakNativeCurrentLap = 0;
    this.lastActivePacketTime = 0;
    await this.detector.finalizeCurrentSession(reason);
  }

  async waitForPendingLapWrites(sessionId: number): Promise<void> {
    await this.detector.waitForPendingLapWrites(sessionId);
  }

  getDebugState(): Record<string, unknown> {
    return {
      ...this.detector.getDebugState(),
      iracingPhysicalLap: this.physicalLap,
      iracingDeferredPackets: this.deferred.length,
      iracingWaitingForNativeTime: this.deferred.length > 0,
      iracingPendingUnexpectedLap: this.pendingUnexpectedLap?.packet.LapNumber ?? null,
    };
  }

  private resetGate(packet: TelemetryPacket): void {
    this.sessionKey = packet.sessionUID;
    this.physicalLap = packet.LapNumber;
    this.skipFirstCompletion = true;
    this.deferred = [];
    this.pendingUnexpectedLap = null;
    this.staleLastLap = packet.LastLap;
    this.peakNativeCurrentLap = packet.iracing?.sdkCurrentLapTime ?? 0;
  }

  private defer(packet: TelemetryPacket, rawByteOffset?: number): void {
    this.deferred.push({ packet, rawByteOffset });
    this.peakNativeCurrentLap = Math.max(
      this.peakNativeCurrentLap,
      packet.iracing?.sdkCurrentLapTime ?? 0,
    );
  }

  private nativeTimingRolled(packet: TelemetryPacket): boolean {
    const lastLapChanged =
      packet.LastLap > 0 &&
      Math.abs(packet.LastLap - this.staleLastLap) > 0.000_1;
    const nativeCurrentLap = packet.iracing?.sdkCurrentLapTime;
    const currentTimerReset =
      nativeCurrentLap !== undefined &&
      this.peakNativeCurrentLap > 10 &&
      nativeCurrentLap < Math.min(5, this.peakNativeCurrentLap * 0.5);

    return lastLapChanged || currentTimerReset;
  }

  private async releaseDeferred(lapTime: number): Promise<void> {
    const [boundary, ...rest] = this.deferred;
    this.deferred = [];
    if (!boundary) return;

    await this.detector.feed(
      { ...boundary.packet, LastLap: lapTime },
      boundary.rawByteOffset,
    );
    for (const entry of rest) {
      await this.detector.feed(entry.packet, entry.rawByteOffset);
    }
  }

  private async acceptUnexpectedLap(entry: DeferredPacket): Promise<void> {
    this.deferred = [];
    this.physicalLap = entry.packet.LapNumber;
    this.skipFirstCompletion = true;
    await this.detector.feed(entry.packet, entry.rawByteOffset);
  }
}
