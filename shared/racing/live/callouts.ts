import type { GameId } from "../../games/ids";

export type LiveCalloutBoundary = "lap" | "sector";
export type LiveCalloutPriority = "high" | "normal" | "low";
export type LivePaceBenchmarkKind = "recent-opponent" | "session-best-opponent";

export interface LivePaceReference {
  kind: LivePaceBenchmarkKind;
  label: string;
  lapTimeSec: number;
  source: "native" | "session";
  observedAtMs: number;
  valid: true;
  classId: string | number;
  className?: string;
}

export interface LiveEngineerCandidate {
  id: string;
  dedupeKey: string;
  sessionId: number;
  gameId: GameId;
  boundary: LiveCalloutBoundary;
  boundaryNumber: number;
  priority: LiveCalloutPriority;
  createdAtMs: number;
  expiresAtMs: number;
  subject: { id: string; name: string; classId: string | number; className?: string };
  playerLapTimeSec: number;
  reference: LivePaceReference;
  deltaSec: number;
  text: string;
  audioUrl?: string;
}

export interface LiveEngineerDecision {
  candidate: LiveEngineerCandidate;
  status: "queued" | "delivered" | "dropped";
  reason?:
    | "cooldown"
    | "duplicate"
    | "queue-full"
    | "expired"
    | "revalidation-failed"
    | "delivered";
  decidedAtMs: number;
}

export interface LiveEngineerAck {
  type: "live-engineer-ack";
  candidateId: string;
  accepted: boolean;
  playedAtMs?: number;
}

export interface LiveEngineerNotification {
  type: "live-engineer-callout";
  candidateId: string;
  sessionId: number;
  gameId: GameId;
  boundary: LiveCalloutBoundary;
  boundaryNumber: number;
  priority: LiveCalloutPriority;
  text: string;
  audioUrl?: string;
  exactPace: {
    playerLapTimeSec: number;
    opponentLapTimeSec: number;
    deltaSec: number;
    opponent: string;
    className?: string;
  };
}

export interface LiveEngineerRuntimeOptions {
  nowMs?: () => number;
  cooldownMs?: number;
  maxQueue?: number;
  revalidate?: (candidate: LiveEngineerCandidate) => boolean;
  deliver?: (candidate: LiveEngineerCandidate) => void;
}
export interface OpponentPaceSample {
  id: string;
  name: string;
  classId: string | number;
  className?: string;
  valid: boolean;
  onPitRoad?: boolean;
  lastLapTimeSec?: number;
  bestLapTimeSec?: number;
  completedAtMs: number;
}

export interface OpponentPaceFrame {
  sessionId: number;
  gameId: GameId;
  sessionType?: string;
  safetyCar?: boolean;
  onPitRoad?: boolean;
  playerClassId: string | number;
  playerClassName?: string;
  opponents: readonly OpponentPaceSample[];
  observedAtMs: number;
}
