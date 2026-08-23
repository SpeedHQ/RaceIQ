import { getGame } from "@shared/games/registry";
import { resolveWheelStates } from "@shared/racing/analysis/metric-values";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { WeightShiftRadar } from "@/components/WeightShiftRadar";
import type { SemanticAnalysisFrame } from "@/components/analyse/track-map/types";
import { useUnits } from "@/hooks/useUnits";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import { convertTemp } from "@/lib/temperature";
import { m } from "@/paraglide/messages";
import { SuspBar } from "./SuspBar";
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
  const adapter = getGame(gameId);
  const analysis = resolveAnalysisTelemetry(adapter);
  const temps = numericWheels(frame, "tire.temperature.average");
  const wear = numericWheels(frame, "tires.tire-wear");
  const angles = numericWheels(frame, "tires.tire-slip-angle");
  const suspension = numericWheels(frame, "suspension.norm-suspension-travel");
  const suspensionM = numericWheels(frame, "suspension.suspension-travel-m");
  const brakes = numericWheels(frame, "brakes.brake-temp");
  const states = resolveWheelStates(frame, analysis.traction);
  const steering = numeric(frame, "inputs.steer");
  const temperatureAvailable = temps.some((value) => value != null);
  const healthAvailable = wear.some((value) => value != null);
  const showMillimeters = analysis.suspensionTravel.source !== "unavailable" && analysis.suspensionTravel.display === "millimeters";
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
        tempFn={(value) => convertTemp(value, units.tempUnit, "C")}
        tempUnit={units.tempUnit}
        onRumble={false}
        puddleDepth={0}
        brakeTemp={brakes[index] ?? undefined}
        showSlipAngle={showSlipAngle}
        showWheelState={showWheelState}
        tempCaption={analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot" ? m.analyse_wheels_pit_temp() : m.analyse_wheels_temp()}
        healthCaption={analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot" ? m.analyse_wheels_pit_health() : m.analyse_wheels_health()}
        temperatureAvailable={temperatureAvailable}
        healthAvailable={healthAvailable}
      />
    );
  };
  const suspensionBar = (index: number) => {
    const normalized = suspension[index];
    const meters = suspensionM[index];
    if (normalized === null && meters === null) return null;
    return (
      <SuspBar
        norm={normalized ?? 0}
        thresholds={adapter.suspensionThresholds.values}
        mmTravel={showMillimeters && meters !== null ? meters * 1000 : undefined}
        mmMode={adapter.suspensionThresholds.millimeterMode ?? "absolute"}
      />
    );
  };
  return (
    <div className="relative flex w-full max-w-xs flex-col gap-3 mx-auto">
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <WeightShiftRadar frame={frame} />
      </div>
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          {wheel(0, "left")}
          {suspensionBar(0)}
        </div>
        <div className="flex items-center gap-1">
          {suspensionBar(1)}
          {wheel(1, "right")}
        </div>
      </div>
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1">
          {wheel(2, "left")}
          {suspensionBar(2)}
        </div>
        <div className="flex items-center gap-1">
          {suspensionBar(3)}
          {wheel(3, "right")}
        </div>
      </div>
    </div>
  );
}

/**
 * TireDiagram — Arranges canonical telemetry in a front/rear axle layout.
 */
export function TireDiagram(props: { view: LiveTelemetryView; frame?: never; gameId?: never } | { frame: SemanticAnalysisFrame; gameId: Parameters<typeof getGame>[0]; view?: never }) {
  if (props.view) {
    const { view } = props;
    const values: SemanticAnalysisFrame["values"] = {
      "inputs.steer": view.inputs.steer,
      "motion.speed": view.motion.speedMps,
      "tire.temperature.average": view.tires.temperatureC && Object.values(view.tires.temperatureC),
      "tires.tire-wear": view.tires.wear && Object.values(view.tires.wear),
      "tires.tire-slip-angle": view.tires.slipAngleRad && Object.values(view.tires.slipAngleRad),
      "tires.tire-slip-ratio": view.tires.slipRatio && Object.values(view.tires.slipRatio),
      "tires.wheel-rotation-speed": view.tires.rotationRadS && Object.values(view.tires.rotationRadS),
      "tires.tire-radius": view.tires.radiusM && Object.values(view.tires.radiusM),
      "suspension.norm-suspension-travel": view.tires.suspensionNormalized && Object.values(view.tires.suspensionNormalized),
      "suspension.suspension-travel-m": view.tires.suspensionTravelM && Object.values(view.tires.suspensionTravelM),
      "brakes.brake-temp": view.tires.brakeTemperatureC && Object.values(view.tires.brakeTemperatureC),
    };
    return <SemanticTireDiagram frame={{ values, states: {}, freshness: {} }} gameId={view.simulator} />;
  }
  return <SemanticTireDiagram frame={props.frame} gameId={props.gameId} />;
}
