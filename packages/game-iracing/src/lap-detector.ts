import type { DetectorOwnershipState, DetectorOwnershipTransition } from "@raceiq/telemetry-core/processor/ordinal-engine";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import {
  LapDetector,
  type LapFuelData,
  type LapTireWearData,
  type SessionState,
} from "@raceiq/backend-core/lap-detection/detector";
import type {
  ILapDetector,
  LapDetectorOptions,
} from "@raceiq/backend-core/lap-detection/types";

export const LAP_DETECTOR_IRACING_ID = "iracing_lapdetector_v4";

import { IRacingDetectorEngine } from "@raceiq/telemetry-core/processor/iracing-engine";

/**
 * Host adapter for iRacing detection. The processor owns delayed authoritative
 * timing and transition state; persistence and lap lifecycle remain in LapDetector.
 */
export class LapDetectorIRacing implements ILapDetector {
  readonly detectorId = LAP_DETECTOR_IRACING_ID;
  private readonly detector: LapDetector;
  private readonly engine: IRacingDetectorEngine;

  constructor(options: LapDetectorOptions) {
    this.detector = new LapDetector({ ...options, bypassPacketRateFilter: true });
    this.engine = new IRacingDetectorEngine({
      now: () => Date.now(),
      feed: (packet, offset, ordinal) => this.detector.feed(packet, offset, ordinal),
      flushStaleLap: () => this.detector.flushStaleLap(),
      finalizeCurrentSession: () => this.detector.finalizeCurrentSession(),
      observeSourceRecord: (offset, endOffset, ordinal) => this.detector.observeSourceRecord(offset, endOffset, ordinal),
      drainOwnershipTransitions: () => this.detector.drainOwnershipTransitions(),
      getOwnershipState: () => this.detector.getOwnershipState(),
    });
  }
  getOwnershipState(): DetectorOwnershipState { return this.engine.getOwnershipState(); }
  subscribeOwnership(listener: (transition: DetectorOwnershipTransition) => void): () => void {
    return this.engine.subscribeOwnership(listener);
  }
  drainOwnershipTransitions(): DetectorOwnershipTransition[] { return this.engine.drainOwnershipTransitions(); }
  get session(): SessionState | null { return this.detector.session; }
  get fuelHistory(): LapFuelData[] { return this.detector.fuelHistory; }
  get tireWearHistory(): LapTireWearData[] { return this.detector.tireWearHistory; }
  shouldCheckpointBeforeWrite(packet: TelemetryPacket): boolean {
    return this.engine.shouldCheckpoint(packet);
  }
  setCurrentLapByteOffset(offset: number, rawOrdinal?: number): void {
    this.detector.setCurrentLapByteOffset(offset, rawOrdinal);
    this.engine.setCurrentLapByteOffset(offset, rawOrdinal);
  }
  observeSourceRecord(offset: number, endOffset: number, ordinal: number): void {
    this.engine.observeSourceRecord(offset, endOffset, ordinal);
  }
  expectCompleteLapStart(): void { this.engine.expectCompleteLapStart(); }
  feed(packet: TelemetryPacket, rawByteOffset?: number, rawOrdinal?: number): Promise<void> {
    return this.engine.feed(packet, rawByteOffset, rawOrdinal);
  }
  flushStaleLap(): Promise<void> { return this.engine.flushStaleLap(); }
  async flushIncompleteLap(): Promise<void> {
    await this.engine.flushIncompleteLap();
    await this.detector.flushIncompleteLap();
  }
  finalizeCurrentSession(): Promise<void> { return this.engine.finalizeCurrentSession(); }
  getDebugState(): Record<string, unknown> {
    return { ...this.detector.getDebugState(), ...this.engine.getDebugState() };
  }
}
