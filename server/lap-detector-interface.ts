/**
 * Shared interface for all lap detector implementations.
 * LapDetector (FM/F1) and LapDetectorAc (ACC/AC Evo) both implement ILapDetector.
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

/** Unified constructor options accepted by all lap detector implementations. */
export interface LapDetectorOptions {
  db: DbAdapter;
  callbacks?: LapDetectorCallbacks;
  /** FM/F1 only: bypass the 30 pps packet-rate filter (used in tests). AC detector ignores this. */
  bypassPacketRateFilter?: boolean;
}

/** Common interface implemented by all lap detector variants. */
export interface ILapDetector {
  readonly detectorId: string;
  readonly session: SessionState | null;
  feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void>;
  /** FM/F1 only — optional so AC detector doesn't have to implement it. */
  readonly fuelHistory?: import("./lap-detector").LapFuelData[];
  /** FM/F1 only — optional so AC detector doesn't have to implement it. */
  readonly tireWearHistory?: import("./lap-detector").LapTireWearData[];
  /** Flush a stale in-progress lap when packets stop arriving. FM/F1 only. */
  flushStaleLap?(): Promise<void>;
  /** Flush any in-progress lap at end-of-stream as an invalid incomplete lap. */
  flushIncompleteLap?(): Promise<void>;
  /** Finalize current session immediately (e.g., when game disconnects). */
  finalizeCurrentSession?(): Promise<void>;
  /**
   * Overwrite the current in-progress lap's byte offset. Called by the
   * pipeline when the session recorder is created mid-feed and the first
   * packet is retroactively written — without this, lap 1's byte offset is
   * stuck at null.
   */
  setCurrentLapByteOffset?(offset: number): void;
  /** Return internal debug state for the dev panel. FM/F1 only. */
  getDebugState?(): Record<string, unknown>;
}

/** Factory function type — each game adapter provides one of these. */
export type LapDetectorFactory = (opts: LapDetectorOptions) => ILapDetector;
