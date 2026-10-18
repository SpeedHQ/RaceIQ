import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { PitCycleReason } from "./pit-cycle";

/** Resolve category only from positive native evidence within the lap window. */
export function classifyLapCategory(
  packets: readonly TelemetryPacket[],
  pitReason: PitCycleReason | null,
  boundaryPacket?: TelemetryPacket,
  qualityValid = false,
): LapClassification | null {
  let gridStart = false;
  let caution = false;
  let freshVehicleFlag = false;
  let freshSafetyCarStatus = false;
  let noCautionF1State = true;
  let completeAccSignals = true;
  const lapStart = packets[0]?.CurrentRaceTime;
  const lapEnd = packets.at(-1)?.CurrentRaceTime;
  for (const packet of packets) {
    const f1 = packet.f1;
    const acc = packet.acc;
    if (f1?.raceStartAt !== undefined && lapStart !== undefined && lapEnd !== undefined
      && f1.raceStartAt >= lapStart && f1.raceStartAt <= lapEnd) gridStart = true;
    // F1 can emit LGOT before the first telemetry sample; native lap 1 ties that
    // confirmed start event to this lap without leaking it into later laps.
    if (packet.gameId === "f1-2025" && packet.LapNumber === 1 && f1?.raceStartAt !== undefined
      && packet.CurrentRaceTime >= f1.raceStartAt) gridStart = true;
    if (packet !== boundaryPacket) {
      if ((packet.gameId === "acc" || packet.gameId === "ac-evo") && acc?.flagStatus === "yellow") caution = true;
      if (f1?.vehicleFIAFlags === 3 && f1.vehicleFIAFlagsUpdatedAt !== undefined
        && lapStart !== undefined && lapEnd !== undefined
        && f1.vehicleFIAFlagsUpdatedAt >= lapStart && f1.vehicleFIAFlagsUpdatedAt <= lapEnd) caution = true;
      if ((f1?.safetyCarStatus === 1 || f1?.safetyCarStatus === 2)
        && f1.safetyCarStatusUpdatedAt !== undefined && lapStart !== undefined && lapEnd !== undefined
        && f1.safetyCarStatusUpdatedAt >= lapStart && f1.safetyCarStatusUpdatedAt <= lapEnd) caution = true;
    }
    if (f1?.vehicleFIAFlagsUpdatedAt !== undefined && lapStart !== undefined && lapEnd !== undefined
      && f1.vehicleFIAFlagsUpdatedAt >= lapStart && f1.vehicleFIAFlagsUpdatedAt <= lapEnd) freshVehicleFlag = true;
    if (f1?.safetyCarStatusUpdatedAt !== undefined && lapStart !== undefined && lapEnd !== undefined
      && f1.safetyCarStatusUpdatedAt >= lapStart && f1.safetyCarStatusUpdatedAt <= lapEnd) freshSafetyCarStatus = true;
    if (f1?.vehicleFIAFlags === undefined || f1.vehicleFIAFlags === -1
      || f1.safetyCarStatus === undefined || f1.safetyCarStatus === 3) noCautionF1State = false;
    if (acc?.pitStatus !== "out" || acc.flagStatus === undefined || acc.flagStatus === "yellow") completeAccSignals = false;
  }
  if (gridStart) return "grid_start";
  if (pitReason === "pit lap") return "pit_lap";
  if (pitReason === "inlap") return "in_lap";
  if (pitReason === "outlap") return "out_lap";
  if (caution) return "caution";
  if (!qualityValid || packets.length === 0) return null;
  const first = packets[0]!;
  if (first.gameId === "f1-2025") {
    const sessionType = first.f1?.sessionType;
    const nonRaceSession = sessionType !== undefined && sessionType !== "unknown" && !sessionType.startsWith("race");
    const priorRaceStart = first.f1?.raceStartAt !== undefined && lapStart !== undefined && first.f1.raceStartAt < lapStart;
    if ((nonRaceSession || priorRaceStart) && freshVehicleFlag && freshSafetyCarStatus && noCautionF1State) return "pace";
  } else if (first.gameId === "acc" || first.gameId === "ac-evo") {
    const sessionType = first.gameId === "ac-evo" ? first.acc?.acEvo?.sessionType : first.acc?.sessionType;
    const knownNonRace = sessionType !== undefined && sessionType !== "unknown" && sessionType !== "race";
    if (knownNonRace && completeAccSignals) return "pace";
  }
  return null;
}
