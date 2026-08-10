import { getGame } from "@shared/games/registry";
import { allWheelStates } from "@shared/racing/analysis/laps/physics/vehicle";
import { resolveWheelStates } from "@shared/racing/analysis/metric-values";
import { hasTireHealthData, hasTireTemperatureData, resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { WeightShiftRadar } from "@/components/WeightShiftRadar";
import type { SemanticAnalysisFrame } from "@/components/analyse/track-map/types";
import { useUnits } from "@/hooks/useUnits";
import type { DisplayPacket } from "@/lib/convert-packet";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import { convertTemp } from "@/lib/temperature";
import { m } from "@/paraglide/messages";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import { SuspBar } from "./SuspBar";
import { TireGrid } from "./TireGrid";
import { WheelCard } from "./WheelCard";

const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const numericWheels = (frame: SemanticAnalysisFrame, id: string): (number | null)[] => {
  const value = frame.values[id];
  return WHEELS.map((_, index) => (Array.isArray(value) && typeof value[index] === "number" && Number.isFinite(value[index]) ? value[index] : null));
};
const numeric = (frame: SemanticAnalysisFrame, id: string): number | null => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

function SemanticTireDiagram({ frame, gameId }: { frame: SemanticAnalysisFrame; gameId: Parameters<typeof getGame>[0] }) {
  const units = useUnits();
  const analysis = resolveAnalysisTelemetry(getGame(gameId));
  const temps = numericWheels(frame, "tire.temperature.average");
  const wear = numericWheels(frame, "tires.tire-wear");
  const angles = numericWheels(frame, "tires.tire-slip-angle");
  const suspension = numericWheels(frame, "suspension.norm-suspension-travel");
  const brakes = numericWheels(frame, "brakes.brake-temp");
  const states = resolveWheelStates(frame, analysis.traction);
  const steering = numeric(frame, "inputs.steer");
  const temperatureAvailable = temps.some((value) => value != null);
  const healthAvailable = wear.some((value) => value != null);
  const showSlipAngle = angles.some((value) => value != null);
  const showWheelState = states.some((state) => state != null);
  const steerAngle = steering == null ? 0 : (steering / 127) * 20;
  const wheel = (index: number, outerSide: "left" | "right") => {
    const resolvedState = states[index];
    const state = resolvedState ? { state: resolvedState.state, slipRatio: resolvedState.slipRatio } : { state: "idle" as const, slipRatio: 0 };
    return (
      <WheelCard
        label={WHEELS[index]}
        temp={temps[index] ?? 0}
        wear={wear[index] ?? 0}
        slipAngle={(angles[index] ?? 0) * (180 / Math.PI)}
        outerSide={outerSide}
        wheelState={state}
        steerAngle={index < 2 ? steerAngle : 0}
        thresholds={units.thresholds}
        tempFn={(value) => convertTemp(value, "C", units.tempUnit)}
        tempUnit={units.tempUnit}
        onRumble={false}
        puddleDepth={0}
        brakeTemp={brakes[index] ?? undefined}
        showSlipAngle={showSlipAngle}
        showWheelState={showWheelState}
        tempCaption={m.analyse_wheels_temp()}
        healthCaption={m.analyse_wheels_health()}
        temperatureAvailable={temperatureAvailable}
        healthAvailable={healthAvailable}
      />
    );
  };
  const suspensionBar = (index: number) => <SuspBar norm={suspension[index] ?? 0} thresholds={[0.25, 0.65, 0.85]} />;
  return (
    <div className="relative flex w-full max-w-xs flex-col gap-3 mx-auto">
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <WeightShiftRadar frame={frame} />
      </div>
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">{wheel(0, "left")}{suspensionBar(0)}</div>
        <div className="flex items-center gap-1">{suspensionBar(1)}{wheel(1, "right")}</div>
      </div>
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">{wheel(2, "left")}{suspensionBar(2)}</div>
        <div className="flex items-center gap-1">{suspensionBar(3)}{wheel(3, "right")}</div>
      </div>
    </div>
  );
}

/**
 * TireDiagram — Arranges 4 WheelCards in a front/rear axle layout with suspension bars.
 * Supports both legacy packets/live views and semantic Analyse frames.
 */
export function TireDiagram({ packet, frame, view, gameId }: { packet?: DisplayPacket | TelemetryPacket; frame?: SemanticAnalysisFrame; view?: LiveTelemetryView; gameId?: Parameters<typeof getGame>[0] }) {
  const units = useUnits();
  if (frame) return <SemanticTireDiagram frame={frame} gameId={view?.simulator ?? gameId ?? "ac-evo"} />;
  if (!packet && view) {
    const t = view.tires;
    return <TireGrid fl={{ tempC: t.temperatureC?.fl ?? 0, wear: t.wear?.fl ?? 0 }} fr={{ tempC: t.temperatureC?.fr ?? 0, wear: t.wear?.fr ?? 0 }} rl={{ tempC: t.temperatureC?.rl ?? 0, wear: t.wear?.rl ?? 0 }} rr={{ tempC: t.temperatureC?.rr ?? 0, wear: t.wear?.rr ?? 0 }} healthThresholds={{ green: 0.7, yellow: 0.4 }} tempThresholds={{ blue: 60, orange: 85, red: 100 }} />;
  }
  if (!packet) return null;
  const adapter = getGame(view?.simulator ?? packet.gameId);
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
