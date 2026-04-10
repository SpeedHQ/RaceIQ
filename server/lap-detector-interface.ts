/**
 * Shared interface for all lap detector implementations.
 * Both LapDetector (v1) and LapDetectorV2 implement ILapDetector.
 */
import type { TelemetryPacket } from "../shared/types";
import type { DbAdapter } from "./pipeline-adapters";

// Re-export all event/state types so callers only need one import point
export type {
  SessionState,
  LapSavedEvent,
  LapSavedNotification,
  LapCompleteEvent,
  LapFuelData,
  LapTireWearData,
} from "./lap-detector";

import type { SessionState, LapSavedEvent, LapSavedNotification, LapCompleteEvent } from "./lap-detector";

/** The three optional event callbacks shared by both detector implementations. */
export interface LapDetectorCallbacks {
  onLapSaved?: (event: LapSavedEvent | LapSavedNotification) => void;
  onSessionStart?: (session: SessionState) => void | Promise<void>;
  onLapComplete?: (event: LapCompleteEvent) => void;
}

/** Unified constructor options accepted by both LapDetector and LapDetectorV2. */
export interface LapDetectorOptions {
  db: DbAdapter;
  callbacks?: LapDetectorCallbacks;
  /** v1-specific: bypass the 30 pps packet-rate filter (used in tests). v2 ignores this. */
  bypassPacketRateFilter?: boolean;
}

/** Common interface implemented by all lap detector variants. */
export interface ILapDetector {
  readonly session: SessionState | null;
  feed(packet: TelemetryPacket): Promise<void>;
  /** v1 only — optional so v2 doesn't have to implement it. */
  readonly fuelHistory?: import("./lap-detector").LapFuelData[];
  /** v1 only — optional so v2 doesn't have to implement it. */
  readonly tireWearHistory?: import("./lap-detector").LapTireWearData[];
  /** Flush a stale in-progress lap when packets stop arriving. v1 only. */
  flushStaleLap?(): Promise<void>;
  /** Flush any in-progress lap at end-of-stream as an invalid incomplete lap. */
  flushIncompleteLap?(): Promise<void>;
  /** Return internal debug state for the dev panel. v1 only. */
  getDebugState?(): Record<string, unknown>;
}

/** Factory function type — each game adapter provides one of these. */
export type LapDetectorFactory = (opts: LapDetectorOptions) => ILapDetector;
