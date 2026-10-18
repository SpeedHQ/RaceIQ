import type { LapClassification } from "@raceiq/shared/racing/lap-classification";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { PitCycleReason } from "./pit-cycle";

/** A native pit entry plus an impossible world-position jump identifies an ACC reset. */
function isAccPitReset(before: TelemetryPacket, after: TelemetryPacket): boolean {
  if (before.gameId !== "acc" || after.gameId !== "acc" || before.acc?.pitStatus !== "out"
    || (after.acc?.pitStatus !== "pit_lane" && after.acc?.pitStatus !== "in_pit")) return false;
  // Older captures may decode adjacent frames with the same wall-clock timestamp.
  // Native lap time supplies elapsed time only when both frames belong to the same lap.
  const elapsed = before.TimestampMS === after.TimestampMS && before.LapNumber === after.LapNumber
    ? after.CurrentLap - before.CurrentLap
    : (after.TimestampMS - before.TimestampMS) / 1_000;
  // Long capture gaps, clock resets, and unavailable coordinates cannot prove a teleport.
  if (!(elapsed > 0 && elapsed <= 1)
    || !Number.isFinite(before.PositionX) || !Number.isFinite(before.PositionY) || !Number.isFinite(before.PositionZ)
    || !Number.isFinite(after.PositionX) || !Number.isFinite(after.PositionY) || !Number.isFinite(after.PositionZ)
    || !Number.isFinite(before.Speed) || !Number.isFinite(after.Speed)
    || before.Speed < 0 || after.Speed < 0
    || (before.PositionX === 0 && before.PositionY === 0 && before.PositionZ === 0)
    || (after.PositionX === 0 && after.PositionY === 0 && after.PositionZ === 0)) return false;
  const dx = after.PositionX - before.PositionX;
  const dy = after.PositionY - before.PositionY;
  const dz = after.PositionZ - before.PositionZ;
  // Speed is m/s. Allow 25 m of sampling/acceleration slack and require a substantial jump.
  const plausibleDistance = Math.max(50, Math.max(before.Speed, after.Speed) * elapsed + 25);
  return dx * dx + dy * dy + dz * dz > plausibleDistance * plausibleDistance;
}

/** Resolve non-pace categories from native evidence, then apply each game's pace policy. */
export function classifyLapCategory(
  packets: readonly TelemetryPacket[],
  pitReason: PitCycleReason | null,
  boundaryPacket?: TelemetryPacket,
  qualityValid = false,
): LapClassification | null {
  let gridStart = false;
  let caution = false;
  let reset = false;
  let freshVehicleFlag = false;
  let freshSafetyCarStatus = false;
  let noCautionF1State = true;
  let completeAccSignals = true;
  const lapStart = packets[0]?.CurrentRaceTime;
  const lapEnd = packets.at(-1)?.CurrentRaceTime;
  for (let index = 0; index < packets.length; index++) {
    const packet = packets[index]!;
    if (index > 0 && packet !== boundaryPacket && isAccPitReset(packets[index - 1]!, packet)) reset = true;
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
  if (reset) return "reset";
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
  } else if (first.gameId === "fm-2023" || first.gameId === "iracing" || first.gameId === "lmu") {
    // These sources do not provide the complete start/caution signals required above.
    // A quality-valid lap without detected non-pace evidence remains ordinary pace.
    return "pace";
  }
  return null;
}
