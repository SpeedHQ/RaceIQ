import { classifyPitCycleLap, type PitCycleReason } from "@raceiq/analysis-core/racing/laps/pit-cycle";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

/** True when Kunos capture attached after current lap timing had begun. */
export function kunosFirstPacketIsMidLap(packet: TelemetryPacket): boolean {
  return (packet.gameId === "acc" || packet.gameId === "ac-evo") && packet.CurrentLap > 5;
}
export interface KunosLapResetEvidence {
  timerReset: boolean;
  reportedLapAdvanced: boolean;
  reportedLastLapFresh: boolean;
}

/** Classify existing Kunos timer-reset evidence without owning detector state. */
export function getKunosLapResetEvidence(
  previous: TelemetryPacket,
  packet: TelemetryPacket,
  currentLapNumber: number,
): KunosLapResetEvidence {
  return {
    timerReset: previous.CurrentLap >= 5 && packet.CurrentLap <= 2,
    reportedLapAdvanced: (packet.LapNumber ?? currentLapNumber) > currentLapNumber,
    reportedLastLapFresh:
      (packet.LastLap ?? 0) > 0 && (packet.LastLap ?? 0) !== (previous.LastLap ?? 0),
  };
}

/** ACC pit-lane timer reset is a discarded pre-lap prefix, not a completed lap. */
export function isKunosPreLapTimerReset(
  previous: TelemetryPacket,
  evidence: KunosLapResetEvidence,
): boolean {
  return evidence.timerReset &&
    previous.CurrentLap < 30 &&
    !evidence.reportedLapAdvanced &&
    !evidence.reportedLastLapFresh;
}

/** Kunos completed-lap reset thresholds and authoritative timing evidence. */
export function isKunosCompletedLapReset(
  previous: TelemetryPacket,
  evidence: KunosLapResetEvidence,
): boolean {
  return evidence.timerReset &&
    (previous.CurrentLap >= 30 ||
      evidence.reportedLapAdvanced ||
      evidence.reportedLastLapFresh);
}

/** Consecutive invalid frames required before treating validity drop as a cut. */
const TRACK_LIMITS_MIN_FRAMES = 2;

/** Classify a Kunos lap cut, preserving inherited invalidity and flicker rules. */
export function classifyKunosTrackLimits(packets: readonly TelemetryPacket[]): "track limits" | null {
  if (packets.length === 0) return null;
  const gameId = packets[0].gameId;
  if (gameId !== "acc" && gameId !== "ac-evo") return null;
  if (packets[0].acc?.isValidLap === false) return null;

  let run = 0;
  for (const packet of packets) {
    if (packet.acc?.isValidLap === false) {
      if (++run >= TRACK_LIMITS_MIN_FRAMES) return "track limits";
    } else {
      run = 0;
    }
  }
  return null;
}
/** ACC uses source-reported validity from final completed-lap frame. */
export function resolveAccRecordedLapValidity(
  packets: readonly TelemetryPacket[],
  hasTrigger: boolean,
): boolean | null {
  return packets[packets.length - (hasTrigger ? 2 : 1)]?.acc?.isValidLap ?? null;
}

/** LMU timing fallback preserves the legacy short-buffer rejection. */
export function resolveLMULapTime(packets: readonly TelemetryPacket[], firstPacket: TelemetryPacket): number {
  if (firstPacket.LastLap > 0) return firstPacket.LastLap;
  if (packets.length <= 30) return 0;
  return packets.reduce((peak, packet) => Math.max(peak, packet.CurrentLap), 0);
}

export function resolveLMUInvalidReason(packets: readonly TelemetryPacket[]): string | null {
  return packets.some(packet => packet.lmu?.lapInvalidated) ? "game-invalidated" : null;
}
export function classifyLMUPitCycle(packets: readonly TelemetryPacket[], completedLapCount: number): PitCycleReason | null {
  return classifyPitCycleLap(packets) ?? (completedLapCount === 0 ? "outlap" : null);
}
