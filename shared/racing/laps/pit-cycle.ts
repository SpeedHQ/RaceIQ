import type { TelemetryPacket } from "../../telemetry/types";

/**
 * Laps that are part of a pit cycle carry no representative pace signal:
 * cold tyres, fuel-flow transients, and pit-limiter or stationary time distort
 * lap-time, sector, consistency, and racing-line metrics.
 *
 * The telemetry catalog owns each game's pit-state semantic. This module owns
 * the stateful lap classification that requires first/last samples across a
 * complete lap.
 */
export const PIT_CYCLE_REASONS = ["outlap", "inlap", "pit lap"] as const;

/** Shared persisted reason vocabulary for every supported pit-state source. */
export type PitCycleReason = (typeof PIT_CYCLE_REASONS)[number];

export interface PitCycleLap {
  invalidReason?: string | null;
}

const PIT_CYCLE_REASON_LOOKUP: Readonly<Record<PitCycleReason, true>> = {
  outlap: true,
  inlap: true,
  "pit lap": true,
};

export interface ForzaPitTransitionEvidence {
  detected: boolean;
  raceOffObserved: boolean;
  timingGap: boolean;
  fuelIncreased: boolean;
  tireWearRefreshed: boolean;
}

const FORZA_SERVICE_DELTA = 0.005;
const FORZA_TIMING_GAP_SECONDS = 2;

/**
 * FM has no pit-state field. A race-off gap across a lap boundary is primary
 * evidence; missed lap time identifies the same transition in captures that
 * omit race-off frames. Fuel gain and tire-wear reset remain optional
 * corroboration and can recover the classification when either timing marker
 * is unavailable.
 */
export function forzaPitTransitionEvidence(
  before: TelemetryPacket,
  after: TelemetryPacket,
  raceOffObserved = false,
): ForzaPitTransitionEvidence {
  const isForza = before.gameId === "fm-2023" && after.gameId === "fm-2023";
  const lapAdvanced = after.LapNumber > before.LapNumber;
  const timingGap =
    Number.isFinite(after.CurrentLap) &&
    Number.isFinite(after.LastLap) &&
    Number.isFinite(before.CurrentLap) &&
    after.CurrentLap >= FORZA_TIMING_GAP_SECONDS &&
    after.LastLap - before.CurrentLap >= FORZA_TIMING_GAP_SECONDS;
  const fuelIncreased =
    Number.isFinite(before.Fuel) &&
    Number.isFinite(after.Fuel) &&
    before.Fuel >= 0 &&
    after.Fuel - before.Fuel >= FORZA_SERVICE_DELTA;
  const beforeWear = [before.TireWearFL, before.TireWearFR, before.TireWearRL, before.TireWearRR];
  const afterWear = [after.TireWearFL, after.TireWearFR, after.TireWearRL, after.TireWearRR];
  const wearAvailable = [...beforeWear, ...afterWear].every((value) => Number.isFinite(value) && value >= 0);
  const tireWearRefreshed =
    wearAvailable &&
    beforeWear.reduce((sum, value) => sum + value, 0) / beforeWear.length -
      afterWear.reduce((sum, value) => sum + value, 0) / afterWear.length >=
      FORZA_SERVICE_DELTA;

  return {
    detected: isForza && lapAdvanced && (raceOffObserved || timingGap || fuelIncreased || tireWearRefreshed),
    raceOffObserved,
    timingGap,
    fuelIncreased,
    tireWearRefreshed,
  };
}

function pitState(packet: TelemetryPacket): boolean | undefined {
  if (packet.gameId === "iracing") return packet.iracing?.onPitRoad;
  if (packet.gameId === "f1-2025") {
    const active = packet.f1?.pitLaneTimerActive;
    return active === undefined ? undefined : active === 1;
  }
  if (packet.gameId === "acc" || packet.gameId === "ac-evo") {
    const status = packet.acc?.pitStatus;
    return status === undefined ? undefined : status !== "out";
  }
  return undefined;
}

export function classifyPitCycleLap(packets: readonly TelemetryPacket[]): PitCycleReason | null {
  if (packets.length === 0) return null;

  const startState = pitState(packets[0]);
  const endState = pitState(packets[packets.length - 1]);
  let hasKnownState = startState !== undefined || endState !== undefined;
  let anyInPit = startState === true || endState === true;
  for (let index = 1; index < packets.length - 1 && (!hasKnownState || !anyInPit); index++) {
    const state = pitState(packets[index]);
    hasKnownState ||= state !== undefined;
    anyInPit ||= state === true;
  }
  if (!hasKnownState) return null;

  const startInPit = startState === true;
  const endInPit = endState === true;

  if (startInPit && endInPit) return "pit lap";
  if (endInPit) return "inlap";
  if (anyInPit) return "outlap";
  return null;
}

export function isPitCycleLap(lap: PitCycleLap): boolean {
  return lap.invalidReason != null && lap.invalidReason in PIT_CYCLE_REASON_LOOKUP;
}
