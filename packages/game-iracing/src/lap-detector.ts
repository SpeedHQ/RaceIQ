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
      feed: (packet, offset) => this.detector.feed(packet, offset),
      flushStaleLap: () => this.detector.flushStaleLap(),
      finalizeCurrentSession: () => this.detector.finalizeCurrentSession(),
    });
  }
  get session(): SessionState | null { return this.detector.session; }
  get fuelHistory(): LapFuelData[] { return this.detector.fuelHistory; }
  get tireWearHistory(): LapTireWearData[] { return this.detector.tireWearHistory; }
  setCurrentLapByteOffset(offset: number): void { this.detector.setCurrentLapByteOffset(offset); }
  expectCompleteLapStart(): void { this.engine.expectCompleteLapStart(); }
  feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void> {
    return this.engine.feed(packet, rawByteOffset);
  }
  flushStaleLap(): Promise<void> { return this.engine.flushStaleLap(); }
  flushIncompleteLap(): Promise<void> { return this.engine.flushIncompleteLap(); }
  finalizeCurrentSession(): Promise<void> { return this.engine.finalizeCurrentSession(); }
  getDebugState(): Record<string, unknown> {
    return { ...this.detector.getDebugState(), ...this.engine.getDebugState() };
  }
}
