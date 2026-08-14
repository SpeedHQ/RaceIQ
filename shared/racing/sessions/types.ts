import type { GameId } from "@shared/games/ids";
import type { LapClassification } from "@shared/racing/laps/classification";

import type { TelemetryVersionIdentity } from "@shared/telemetry/version";
import type { EligibilityDecisionSet, EvidenceSourceKind, LapQualitySummary, RecordingQualitySummary, SourceChannelProfile } from "@shared/racing/quality/contracts";

export type SessionOwnership = "mine" | "others";

export interface LapMeta extends Partial<TelemetryVersionIdentity>, Partial<LapClassification> {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;

  invalidReason?: string;
  notes?: string;
  createdAt: string;
  pi?: number;
  gameId?: GameId;
  // Joined from session
  carOrdinal?: number;
  trackOrdinal?: number;
  // Telemetry evidence origin. Missing legacy values are normalized to
  // "unknown"; callers must not infer native live capture from absence.
  source?: EvidenceSourceKind;
  ownership?: SessionOwnership;
  quality?: LapQualitySummary;
  eligibility?: EligibilityDecisionSet;
  qualityGeneration?: string;
  qualityStale?: boolean;
  // Car setup snapshot (JSON string of F1CarSetup)
  carSetup?: string;
  // Tune assignment
  tuneId?: number;
  tuneName?: string;
  // Ordered sector times from the session's source-defined layout (#134).
  sectorTimes?: number[];
  // Explicit experiment link (migration v25). Stamped at insert from the
  // active experiment; null for laps recorded outside an experiment.
  experimentId?: number | null;
  // Explicit tuning-test (setup version) link (migration v29). Null when the lap
  // predates head tracking or was driven with no head set.
  experimentVersionId?: number | null;
  // User flag (migration v30): true = manually excluded from the tuning
  // aggregate. Undefined/false = included.
  experimentExcluded?: boolean;
  // Source of the experimentExcluded decision (migration v34): 'auto' = the
  // fastest-5 curation pass (server/experiments/auto-exclude.ts) owns this lap's
  // state and may revise it on a later lap save; 'manual' = user/AI decided,
  // pinned against the auto pass. Undefined/null = not yet reconciled.
  experimentExcludedSource?: "auto" | "manual" | null;
  // Persisted per-lap metrics (migration v32), derived once from telemetry and
  // cached on the lap row. Null/undefined = not yet computed or no usable
  // telemetry channel.
  fuelPerLap?: number | null;
  tyreWear?: number | null;
  // Number of raw telemetry frames stored for this lap (`laps.raw_frame_count`).
  // One integer on the row, so a caller can budget decode cost WITHOUT decoding
  // anything — see FRAME_BUDGET_PER_ARM in server/experiments/comparison/stream.ts. Only
  // populated by queries that ask for it; undefined means "not selected", not
  // "no frames".
  rawFrameCount?: number | null;
}

export interface SessionMeta extends Partial<TelemetryVersionIdentity> {
  id: number;
  carOrdinal: number;
  trackOrdinal: number;
  createdAt: string;
  lapCount?: number;
  bestLapTime?: number;
  sessionType?: string;
  resultClassification?: string | null;
  finishingPosition?: number | null;
  qualifyingPosition?: number | null;
  isPodium?: boolean | null;
  isFastestLap?: boolean | null;
  pitCount?: number | null;
  pitDurationSeconds?: number | null;
  notes?: string;
  /** Telemetry evidence origin. Missing legacy values normalize to "unknown". */
  source?: EvidenceSourceKind;
  ownership?: SessionOwnership;
  sourceChannelProfile?: SourceChannelProfile;
  recordingQuality?: RecordingQualitySummary;
  qualityGeneration?: string;
  qualityStale?: boolean;
  gameId?: GameId;
}

export interface SessionLapData extends Partial<LapClassification> {
  lapId: number;
  lapNumber: number;
  lapTimeSec: number;
  isValid: boolean;
  /** Persisted quality evidence and decisions used for recap selection. */
  quality?: LapQualitySummary | null;
  eligibility?: EligibilityDecisionSet | null;
  qualityGeneration?: string | null;
  qualitySchemaVersion?: string | null;
  qualityPolicyVersion?: string | null;
  qualityConfigVersion?: string | null;
}

export interface SessionRecap {
  sessionId: number;
  gameId: GameId;
  carName: string;
  trackName: string;
  /** Raw ordinals, for deep-linking into the analyse view. */
  carOrdinal: number;
  trackOrdinal: number;
  createdAt: string;

  /** Structurally valid, pace-classified laps with positive times. */
  lapsValid: number;
  /** Every lap row, including invalid ones. Display only ("valid/total"). */
  lapsTotal: number;
  /** Fastest valid lap, seconds. Null when no valid laps. */
  bestLapSec: number | null;
  /** Lap id of the fastest valid lap, for deep-linking. Null when no valid laps. */
  bestLapId: number | null;
  /** Sum of lapTime over VALID laps only — invalid laps are often detector artifacts. */
  timeOnTrackSec: number;
  /** trackLength * lapsValid, metres. Null when the track has no outline. */
  distanceM: number | null;
  /** Every recorded lap in lap order, including classified non-pace laps. */
  sparkline: SessionLapData[];

  /** Best sectors across pace-eligible laps, possibly from different laps. */
  theoretical: {
    bestSectorTimes: number[];
    sumSec: number;
    /** bestLapSec - sumSec, clamped >= 0. The time left on the table. */
    deltaToBestSec: number;
  } | null;

  /** Source-defined sector start fractions for this session's layout. */
  sectorStarts: number[] | null;

  /** First valid lap minus best lap, clamped >= 0. Null when fewer than 2 valid laps. */
  improvementSec: number | null;
  /** Population stddev of valid lap times, rated relative to best lap. Null when fewer than 3 valid laps. */
  consistency: {
    stdDevSec: number;
    rating: 1 | 2 | 3 | 4 | 5;
  } | null;
  /** Compared against other sessions with the same track + car + game. Null when bestLapSec is null. */
  personalBest: {
    isNew: boolean;
    /** Null when this is the first ever session on this track + car. */
    previousBestSec: number | null;
  } | null;

  /**
   * Per-sector breakdown of the session, for the sector-coloured track map.
   * Null when no valid lap has a complete set of sectors (same condition as `theoretical`).
   */
  sectors:
    | {
        /** One-based sector index in the source-defined layout. */
        index: number;
        /** This sector's time on the session's BEST lap. */
        bestLapSec: number;
        /** Fastest time in this sector across all valid laps this session (feeds `theoretical`). */
        sessionBestSec: number;
        /** Fastest ever in this sector for this track+car+game, EXCLUDING this session. Null if none. */
        allTimeBestSec: number | null;
        /**
         * record       = sessionBestSec beat allTimeBestSec (or there is no all-time yet) — a new record
         * session-best = the best lap's sector equals this session's best in that sector
         * lost         = the best lap lost time in this sector vs this session's own best
         */
        status: "record" | "session-best" | "lost";
      }[]
    | null;
}
