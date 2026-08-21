import type { TelemetryPacket } from "../../telemetry/types";

/**
 * Pit transitions carry no representative pace signal: cold tyres,
 * fuel-flow transients, and pit-limiter or stationary time distort lap pace.
 * Input packets are canonical packets emitted by each game normalizer.
 */
export type PitCyclePhase = "out" | "in" | "pit";

const PIT_LAP = "pit" satisfies PitCyclePhase;

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

export function classifyPitCycle(packets: readonly TelemetryPacket[]): PitCyclePhase | null {
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

  if (startInPit && endInPit) return PIT_LAP;
  if (endInPit) return "in";
  if (anyInPit) return "out";
  return null;
}
