import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "@/lib/convert-packet";
import { useUnits } from "@/hooks/useUnits";
import { convertTemp } from "@/lib/temperature";
import { WeightShiftRadar } from "@/components/WeightShiftRadar";
import { allWheelStates } from "@/lib/vehicle-dynamics";
import { tryGetGame } from "@shared/games/registry";
import { WheelCard } from "./WheelCard";
import { SuspBar } from "./SuspBar";

/**
 * TireDiagram — Arranges 4 WheelCards in a front/rear axle layout with suspension bars.
 * Derives effective wheel radius from ground speed / rotation speed to calculate
 * spin percentage (how much faster/slower each wheel turns vs ground truth).
 * Falls back to 0.33m radius when stationary to avoid division by zero.
 */
export function TireDiagram({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const units = useUnits();
  const suspThresh = tryGetGame(packet.gameId)?.suspensionThresholds.values ?? [25, 65, 85];
  const toDeg = 180 / Math.PI;

  // Use canonical wheel states from vehicle-dynamics (same as LapAnalyse)
  const ws = allWheelStates(packet);

  // Steer: signed int8 (-128 to 127), 0=center. Convert to degrees (~20° max visual lock)
  const steerDeg = (packet.Steer / 127) * 20;

  const wheels = [
    {
      label: "FL",
      temp: units.toTempC(packet.TireTempFL),
      wear: packet.TireWearFL,
      slipAngle: packet.TireSlipAngleFL * toDeg,
      wheelState: ws.fl,
      steerAngle: steerDeg,
      onRumble: packet.WheelOnRumbleStripFL !== 0,
      puddleDepth: packet.WheelInPuddleDepthFL,
      brakeTemp: packet.BrakeTempFrontLeft,
    },
    {
      label: "FR",
      temp: units.toTempC(packet.TireTempFR),
      wear: packet.TireWearFR,
      slipAngle: packet.TireSlipAngleFR * toDeg,
      wheelState: ws.fr,
      steerAngle: steerDeg,
      onRumble: packet.WheelOnRumbleStripFR !== 0,
      puddleDepth: packet.WheelInPuddleDepthFR,
      brakeTemp: packet.BrakeTempFrontRight,
    },
    {
      label: "RL",
      temp: units.toTempC(packet.TireTempRL),
      wear: packet.TireWearRL,
      slipAngle: packet.TireSlipAngleRL * toDeg,
      wheelState: ws.rl,
      steerAngle: 0,
      onRumble: packet.WheelOnRumbleStripRL !== 0,
      puddleDepth: packet.WheelInPuddleDepthRL,
      brakeTemp: packet.BrakeTempRearLeft,
    },
    {
      label: "RR",
      temp: units.toTempC(packet.TireTempRR),
      wear: packet.TireWearRR,
      slipAngle: packet.TireSlipAngleRR * toDeg,
      wheelState: ws.rr,
      steerAngle: 0,
      onRumble: packet.WheelOnRumbleStripRR !== 0,
      puddleDepth: packet.WheelInPuddleDepthRR,
      brakeTemp: packet.BrakeTempRearRight,
    },
  ];

  const susp = [packet.NormSuspensionTravelFL, packet.NormSuspensionTravelFR, packet.NormSuspensionTravelRL, packet.NormSuspensionTravelRR];

  // AC Evo uses signed mm travel (0 = rest); pass raw mm so SuspBar renders centred mode.
  const isAcEvo = packet.gameId === "ac-evo";
  const suspMm = isAcEvo
    ? [packet.SuspensionTravelMFL * 1000, packet.SuspensionTravelMFR * 1000, packet.SuspensionTravelMRL * 1000, packet.SuspensionTravelMRR * 1000]
    : [undefined, undefined, undefined, undefined];

  return (
    <div className="relative flex flex-col gap-3 w-full max-w-xs mx-auto">
      {/* Front axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[0]} outerSide="left" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[0]} thresholds={suspThresh} mmTravel={suspMm[0]} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[1]} thresholds={suspThresh} mmTravel={suspMm[1]} />
          <WheelCard {...wheels[1]} outerSide="right" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Rear axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[2]} outerSide="left" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[2]} thresholds={suspThresh} mmTravel={suspMm[2]} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[3]} thresholds={suspThresh} mmTravel={suspMm[3]} />
          <WheelCard {...wheels[3]} outerSide="right" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Weight shift radar — absolutely centered between axles */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <WeightShiftRadar packet={packet} />
      </div>
    </div>
  );
}
