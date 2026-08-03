import { getGame } from "@shared/games/registry";
import { allWheelStates } from "@shared/racing/analysis/laps/physics/vehicle";
import { hasTireHealthData, hasTireTemperatureData, resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { WeightShiftRadar } from "@/components/WeightShiftRadar";
import { useUnits } from "@/hooks/useUnits";
import type { DisplayPacket } from "@/lib/convert-packet";
import { convertTemp } from "@/lib/temperature";
import { m } from "@/paraglide/messages";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import { SuspBar } from "./SuspBar";
import { WheelCard } from "./WheelCard";

/**
 * TireDiagram — Arranges 4 WheelCards in a front/rear axle layout with suspension bars.
 * Derives effective wheel radius from ground speed / rotation speed to calculate
 * spin percentage (how much faster/slower each wheel turns vs ground truth).
 * Falls back to 0.33m radius when stationary to avoid division by zero.
 */
export function TireDiagram({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const units = useUnits();
  const adapter = getGame(packet.gameId);
  const telemetryModel = adapter.telemetry;
  const analysis = resolveAnalysisTelemetry(adapter);
  const suspThresh = adapter.suspensionThresholds.values;
  const toDeg = 180 / Math.PI;
  const showPerWheelSurface = analysis.surface.source !== "unavailable" && analysis.surface.display !== "vehicle";
  const wheelPresentation = {
    temperatureAvailable: hasTireTemperatureData(packet, analysis.tireTemperature),
    healthAvailable: hasTireHealthData(packet, analysis.tireHealth),
    showSlipAngle: analysis.slipAngle.source !== "unavailable",
    showWheelState: analysis.traction.source !== "unavailable",
    tempCaption: analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot" ? m.analyse_wheels_pit_temp() : m.analyse_wheels_temp(),
    healthCaption: analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot" ? m.analyse_wheels_pit_health() : m.analyse_wheels_health(),
  };

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
      onRumble: showPerWheelSurface && packet.WheelOnRumbleStripFL !== 0,
      puddleDepth: showPerWheelSurface ? packet.WheelInPuddleDepthFL : 0,
      brakeTemp: telemetryModel.brakeTemperature ? packet.BrakeTempFrontLeft : undefined,
    },
    {
      label: "FR",
      temp: units.toTempC(packet.TireTempFR),
      wear: packet.TireWearFR,
      slipAngle: packet.TireSlipAngleFR * toDeg,
      wheelState: ws.fr,
      steerAngle: steerDeg,
      onRumble: showPerWheelSurface && packet.WheelOnRumbleStripFR !== 0,
      puddleDepth: showPerWheelSurface ? packet.WheelInPuddleDepthFR : 0,
      brakeTemp: telemetryModel.brakeTemperature ? packet.BrakeTempFrontRight : undefined,
    },
    {
      label: "RL",
      temp: units.toTempC(packet.TireTempRL),
      wear: packet.TireWearRL,
      slipAngle: packet.TireSlipAngleRL * toDeg,
      wheelState: ws.rl,
      steerAngle: 0,
      onRumble: showPerWheelSurface && packet.WheelOnRumbleStripRL !== 0,
      puddleDepth: showPerWheelSurface ? packet.WheelInPuddleDepthRL : 0,
      brakeTemp: telemetryModel.brakeTemperature ? packet.BrakeTempRearLeft : undefined,
    },
    {
      label: "RR",
      temp: units.toTempC(packet.TireTempRR),
      wear: packet.TireWearRR,
      slipAngle: packet.TireSlipAngleRR * toDeg,
      wheelState: ws.rr,
      steerAngle: 0,
      onRumble: showPerWheelSurface && packet.WheelOnRumbleStripRR !== 0,
      puddleDepth: showPerWheelSurface ? packet.WheelInPuddleDepthRR : 0,
      brakeTemp: telemetryModel.brakeTemperature ? packet.BrakeTempRearRight : undefined,
    },
  ];

  const susp = [packet.NormSuspensionTravelFL, packet.NormSuspensionTravelFR, packet.NormSuspensionTravelRL, packet.NormSuspensionTravelRR];

  const showMillimeters = analysis.suspensionTravel.source !== "unavailable" && analysis.suspensionTravel.display === "millimeters";
  const suspMm = showMillimeters
    ? [packet.SuspensionTravelMFL * 1000, packet.SuspensionTravelMFR * 1000, packet.SuspensionTravelMRL * 1000, packet.SuspensionTravelMRR * 1000]
    : [undefined, undefined, undefined, undefined];
  const mmMode = packet.gameId === "ac-evo" ? "centered" : "absolute";

  return (
    <div className="relative flex flex-col gap-3 w-full max-w-xs mx-auto">
      {/* Front axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[0]} {...wheelPresentation} outerSide="left" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[0]} thresholds={suspThresh} mmTravel={suspMm[0]} mmMode={mmMode} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[1]} thresholds={suspThresh} mmTravel={suspMm[1]} mmMode={mmMode} />
          <WheelCard {...wheels[1]} {...wheelPresentation} outerSide="right" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Rear axle */}
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          <WheelCard {...wheels[2]} {...wheelPresentation} outerSide="left" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
          <SuspBar norm={susp[2]} thresholds={suspThresh} mmTravel={suspMm[2]} mmMode={mmMode} />
        </div>
        <div className="flex items-center gap-1">
          <SuspBar norm={susp[3]} thresholds={suspThresh} mmTravel={suspMm[3]} mmMode={mmMode} />
          <WheelCard {...wheels[3]} {...wheelPresentation} outerSide="right" thresholds={units.thresholds} tempFn={(c) => convertTemp(c, units.tempUnit, "C")} tempUnit={units.tempUnit} />
        </div>
      </div>

      {/* Normalized compression distribution is omitted for millimeter-only sources. */}
      {!showMillimeters && analysis.suspensionCompressionBias.source !== "unavailable" && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <WeightShiftRadar packet={packet} />
        </div>
      )}
    </div>
  );
}
