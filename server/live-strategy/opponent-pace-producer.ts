import type { GameId } from "../../shared/games/ids";
import type {
  LiveEngineerCandidate,
  OpponentPaceFrame,
  OpponentPaceSample,
} from "../../shared/racing/live/callouts";

export interface CompletedLapPace {
  sessionId: number;
  gameId: GameId;
  lapNumber: number;
  lapTimeSec: number;
  valid: boolean;
  onPitRoad?: boolean;
  safetyCar?: boolean;
  playerClassId: string | number;
  playerClassName?: string;
  sessionType?: string;
  nowMs: number;
}

export interface OpponentPaceProducerOptions {
  maxReferenceAgeMs?: number;
  maxDeltaSec?: number;
  minDeltaSec?: number;
  candidateTtlMs?: number;
}

const RACE_SESSION_TYPES = new Set(["race", "race_1", "race_2", "multiplayer_race"]);
const SESSION_BEST_TYPES = new Set(["practice", "qualifying", "short_qualifying", "time_trial", "hot_stint", "hotlap"]);

export function opponentPaceFrameFromF1(
  sessionId: number,
  packet: { gameId: GameId; CarClass: number; f1?: { grid: readonly { driverId: number; name: string; bestLapTime: number; lastLapTime: number; pitStatus: number }[] }; TimestampMS: number },
): OpponentPaceFrame | null {
  if (packet.gameId !== "f1-2025" || !packet.f1?.grid?.length) return null;
  return {
    sessionId,
    gameId: packet.gameId,
    sessionType: undefined,
    playerClassId: packet.CarClass,
    opponents: packet.f1.grid.map((entry) => ({
      id: String(entry.driverId),
      name: entry.name,
      classId: packet.CarClass,
      valid: entry.pitStatus === 0,
      onPitRoad: entry.pitStatus !== 0,
      bestLapTimeSec: entry.bestLapTime,
      lastLapTimeSec: entry.lastLapTime,
      completedAtMs: packet.TimestampMS,
    })),
    observedAtMs: packet.TimestampMS,
  };
}

export function createOpponentPaceCandidate(
  lap: CompletedLapPace,
  frame: OpponentPaceFrame | null,
  options: OpponentPaceProducerOptions = {},
): LiveEngineerCandidate | null {
  if (!frame || frame.sessionId !== lap.sessionId || frame.gameId !== lap.gameId) return null;
  if (!lap.valid || lap.lapTimeSec <= 0 || lap.onPitRoad || lap.safetyCar || frame.onPitRoad || frame.safetyCar) return null;
  const maxReferenceAgeMs = options.maxReferenceAgeMs ?? 120_000;
  const maxDeltaSec = options.maxDeltaSec ?? 8;
  const minDeltaSec = options.minDeltaSec ?? 0.25;
  const candidateTtlMs = options.candidateTtlMs ?? 10_000;
  const useSessionBest = !RACE_SESSION_TYPES.has((lap.sessionType ?? "").toLowerCase()) || SESSION_BEST_TYPES.has((lap.sessionType ?? "").toLowerCase());
  const references = frame.opponents
    .filter((opponent) => opponent.id !== "player")
    .filter((opponent) => opponent.valid && !opponent.onPitRoad)
    .filter((opponent) => String(opponent.classId) === String(lap.playerClassId))
    .filter((opponent) => lap.nowMs - opponent.completedAtMs <= maxReferenceAgeMs)
    .map((opponent) => ({ opponent, time: useSessionBest ? opponent.bestLapTimeSec : opponent.lastLapTimeSec }))
    .filter((entry): entry is { opponent: OpponentPaceSample; time: number } => Number.isFinite(entry.time) && (entry.time ?? 0) > 0)
    .filter((entry) => Math.abs(entry.time - lap.lapTimeSec) >= minDeltaSec && Math.abs(entry.time - lap.lapTimeSec) <= maxDeltaSec)
    .sort((a, b) => Math.abs(a.time - lap.lapTimeSec) - Math.abs(b.time - lap.lapTimeSec));
  const reference = references[0];
  if (!reference) return null;
  const deltaSec = reference.time - lap.lapTimeSec;
  const faster = deltaSec < 0;
  const amount = Math.abs(deltaSec).toFixed(3);
  const sessionLabel = useSessionBest ? "session best" : "recent lap";
  return {
    id: `${lap.sessionId}:${lap.lapNumber}:${reference.opponent.id}:${sessionLabel}`,
    dedupeKey: `${lap.sessionId}:${reference.opponent.id}:${sessionLabel}`,
    sessionId: lap.sessionId,
    gameId: lap.gameId,
    boundary: "lap",
    boundaryNumber: lap.lapNumber,
    priority: Math.abs(deltaSec) >= 2 ? "high" : "normal",
    createdAtMs: lap.nowMs,
    expiresAtMs: lap.nowMs + candidateTtlMs,
    subject: {
      id: reference.opponent.id,
      name: reference.opponent.name,
      classId: reference.opponent.classId,
      className: reference.opponent.className,
    },
    playerLapTimeSec: lap.lapTimeSec,
    reference: {
      kind: useSessionBest ? "session-best-opponent" : "recent-opponent",
      label: `${reference.opponent.name} ${sessionLabel}`,
      lapTimeSec: reference.time,
      source: "native",
      observedAtMs: reference.opponent.completedAtMs,
      valid: true,
      classId: reference.opponent.classId,
      className: reference.opponent.className,
    },
    deltaSec,
    text: `${reference.opponent.name} is ${amount}s ${faster ? "faster" : "slower"} on ${sessionLabel}.`,
    audioUrl: "/sounds/beep-2.mp3",
  };
}
