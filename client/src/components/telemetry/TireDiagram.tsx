import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "@/lib/convert-packet";
import { useUnits } from "@/hooks/useUnits";
import { useSettings } from "@/hooks/queries";
import { WeightShiftRadar } from "@/components/WeightShiftRadar";
import { allWheelStates } from "@/lib/vehicle-dynamics";
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
  const { displaySettings } = useSettings();
  const suspThresh = displaySettings.suspensionThresholds.values;
  const toDeg = 180 / Math.PI;

  // Use canonical wheel states from vehicle-dynamics (same as LapAnalyse)
  const ws = allWheelStates(packet);

  // Steer: signed int8 (-128 to 127), 0=center. Convert to degrees (~20° max visual lock)
  const steerDeg = (packet.Steer / 127) * 20;

  const wheels = [
    { label: "FL", temp: packet.TireTempFL, wear: packet.TireWearFL, combined: Math.abs(packet.TireCombinedSlipFL), slipAngle: packet.TireSlipAngleFL * toDeg, wheelState: ws.fl, steerAngle: steerDeg, onRumble: packet.WheelOnRumbleStripFL !== 0, puddleDepth: packet.WheelInPuddleDepthFL, brakeTemp: packet.BrakeTempFrontLeft },
    { label: "FR", temp: packet.TireTempFR, wear: packet.TireWearFR, combined: Math.abs(packet.TireCombinedSlipFR), slipAngle: packet.TireSlipAngleFR * toDeg, wheelState: ws.fr, steerAngle: steerDeg, onRumble: packet.WheelOnRumbleStripFR !== 0, puddleDepth: packet.WheelInPuddleDepthFR, brakeTemp: packet.BrakeTempFrontRight },
    { label: "RL", temp: packet.TireTempRL, wear: packet.TireWearRL, combined: Math.abs(packet.TireCombinedSlipRL), slipAngle: packet.TireSlipAngleRL * toDeg, wheelState: ws.rl, steerAngle: 0, onRumble: packet.WheelOnRumbleStripRL !== 0, puddleDepth: packet.WheelInPuddleDepthRL, brakeTemp: packet.BrakeTempRearLeft },
    { label: "RR", temp: packet.TireTempRR, wear: packet.TireWearRR, combined: Math.abs(packet.TireCombinedSlipRR), slipAngle: packet.TireSlipAngleRR * toDeg, wheelState: ws.rr, steerAngle: 0, onRumble: packet.WheelOnRumbleStripRR !== 0, puddleDepth: packet.WheelInPuddleDepthRR, brakeTemp: packet.BrakeTempRearRight },
  ];

  const susp = [
    packet.NormSuspensionTravelFL,
    packet.NormSuspensionTravelFR,
    packet.NormSuspensionTravelRL,
    packet.NormSuspensionTravelRR,
  ];

  return (
    <div className="relative flex flex-col gap-3 w-full max-w-xs mx-auto">
      {/* Front axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[0]} outerSide="left" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[0]} thresholds={suspThresh} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[1]} thresholds={suspThresh} />
          <WheelCard {...wheels[1]} outerSide="right" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Rear axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[2]} outerSide="left" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[2]} thresholds={suspThresh} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[3]} thresholds={suspThresh} />
          <WheelCard {...wheels[3]} outerSide="right" thresholds={units.thresholds} tempFn={units.temp} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Weight shift radar — absolutely centered between axles */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <WeightShiftRadar packet={packet} />
      </div>
    </div>
  );
}
