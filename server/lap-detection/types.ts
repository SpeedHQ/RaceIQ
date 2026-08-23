/**
 * Shared contract for lap detector implementations. Games choose their
 * detector through the server adapter factory; implementations may use
 * protocol-specific detectors or shared detector state machines.
 */
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { DbAdapter } from "../telemetry/pipeline-ports";
import type { EvidenceSourceKind, ParticipantEvidence, SourceChannelProfile } from "../../shared/racing/quality/contracts";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import type { RaceEventId } from "../../shared/racing/events/contracts";
import type { LapTimelineClassificationContext } from "../../shared/racing/laps/classification";
import type { SessionBoundaryReason } from "./boundaries";

// Re-export all event/state types so callers only need one import point
export type {
  SessionState,
  LapEventContext,
  LapSavedEvent,
  LapSavedNotification,
  LapCompleteEvent,
  LapFuelData,
  LapTireWearData,
} from "./detector";

import type { SessionState, LapEventContext, LapSavedEvent, LapSavedNotification, LapCompleteEvent, LapFuelData, LapTireWearData } from "./detector";

/** Optional event callbacks available to every detector implementation. */
export interface LapDetectorCallbacks {
  onLapSaved?: (event: LapSavedEvent | LapSavedNotification, context: LapEventContext) => unknown;
  onSessionStart?: (session: SessionState, context: SessionStartContext) => unknown;
  onSessionEnd?: (session: SessionState, context: SessionEndContext) => unknown;
  onLapEvaluated?: (event: LapCompleteEvent, context: LapEventContext) => unknown;
  onLapComplete?: (event: LapCompleteEvent, context: LapEventContext) => unknown;
}

export type SessionEndReason =
  | SessionBoundaryReason
  | "source-disconnected"
  | "source-stale"
  | "stream-ended"
  | "session-rotated";

export interface SessionStartContext {
  reason: SessionBoundaryReason;
  packet: TelemetryPacket;
}

export interface SessionEndContext {
  reason: SessionEndReason;
  terminalObserved: boolean;
}

export interface LapTimelineContextProvider {
  classificationForLap(
    sessionId: number,
    lapNumber: number,
  ): LapTimelineClassificationContext;
  eventIdsForLap(sessionId: number, lapNumber: number): RaceEventId[];
}

/** Explicit empty provider for fixtures whose scenario contains no timeline facts. */
export const EMPTY_LAP_TIMELINE_CONTEXT: LapTimelineContextProvider = {
  classificationForLap: () => ({ pitPhase: null, conditions: [], gridStart: false }),
  eventIdsForLap: () => [],
};

/** Unified constructor options accepted by all lap detector implementations. */
export interface LapDetectorOptions {
  db: DbAdapter;
  /** Authoritative source for pit/race-control lap classification. Empty for legacy callers. */
  lapTimelineContext?: LapTimelineContextProvider;
  callbacks?: LapDetectorCallbacks;
  /** Bypass an implementation's packet-rate guard when supported (used in tests). */
  bypassPacketRateFilter?: boolean;
  /** Evidence origin used while measuring quality; live capture is default. */
  sourceKind?: EvidenceSourceKind;
  /** Participant identity; local player is default. */
  participant?: ParticipantEvidence;
  /** Override parser/catalog identity for imports and deterministic rebuilds. */
  versionIdentity?: TelemetryVersionIdentity;
  /** Session-wide fidelity overrides supplied by transcoded evidence sources. */
  sourceChannelProfile?: SourceChannelProfile;
}

/** Common interface implemented by all lap detector variants. */
export interface ILapDetector {
  readonly detectorId: string;
  readonly session: SessionState | null;
  feed(packet: TelemetryPacket, rawByteOffset?: number): Promise<void>;
  /** Rolling fuel data when the detector tracks per-lap consumption. */
  readonly fuelHistory?: LapFuelData[];
  /** Rolling tire-wear data when the detector tracks per-lap wear. */
  readonly tireWearHistory?: LapTireWearData[];
  /** Flush a stale in-progress lap when the detector supports timeout finalization. */
  flushStaleLap?(): Promise<void>;
  /** Flush any in-progress lap at end-of-stream as an invalid incomplete lap. */
  flushIncompleteLap?(): Promise<void>;
  /** Finalize current session immediately (e.g., when game disconnects). */
  finalizeCurrentSession?(reason?: SessionEndReason): Promise<void>;
  /**
   * Overwrite the current in-progress lap's byte offset. Called by the
   * pipeline when the session recorder is created mid-feed and the first
   * packet is retroactively written — without this, lap 1's byte offset is
   * stuck at null.
   */
  setCurrentLapByteOffset?(offset: number): void;
  /** Wait until every accepted lap for one session and its persistence follow-ups settle. */
  waitForPendingLapWrites?(sessionId: number): Promise<void>;
  /** Return implementation-specific debug state for the dev panel. */
  getDebugState?(): Record<string, unknown>;
}

/** Factory function type — each game adapter provides one of these. */
export type LapDetectorFactory = (opts: LapDetectorOptions) => ILapDetector;
