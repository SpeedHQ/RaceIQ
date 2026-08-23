import { getGame } from "@shared/games/registry";
import { resolveWheelStates } from "@shared/racing/analysis/metric-values";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { WeightShiftRadar } from "@/components/WeightShiftRadar";
import type { SemanticAnalysisFrame } from "@/components/analyse/track-map/types";
import { useUnits } from "@/hooks/useUnits";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import { m } from "@/paraglide/messages";
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
  const steerAngle = steering == null ? 0 : (steering / 127) * 20;
  const wheel = (index: number, outerSide: "left" | "right") => {
    const resolvedState = states[index];
    const temperature = temps[index];
    const tireWear = wear[index];
    const slipAngle = angles[index];
    const state = resolvedState ? { state: resolvedState.state, slipRatio: resolvedState.slipRatio } : { state: "idle" as const, slipRatio: 0 };
    return (
      <WheelCard
        label={WHEELS[index]}
        temp={temperature ?? 0}
        wear={tireWear ?? 0}
        slipAngle={(slipAngle ?? 0) * (180 / Math.PI)}
        outerSide={outerSide}
        wheelState={state}
        steerAngle={index < 2 ? steerAngle : 0}
        thresholds={units.thresholds}
        tempFn={units.temp}
        tempUnit={units.tempUnit}
        onRumble={false}
        puddleDepth={0}
        brakeTemp={brakes[index] ?? undefined}
        showSlipAngle={slipAngle != null}
        showWheelState={resolvedState != null}
        tempCaption={m.analyse_wheels_temp()}
        healthCaption={m.analyse_wheels_health()}
        temperatureAvailable={temperature != null}
        healthAvailable={tireWear != null}
      />
    );
  };
  const suspensionBar = (index: number) => <SuspBar norm={suspension[index] ?? undefined} thresholds={[0.25, 0.65, 0.85]} />;
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
 * TireDiagram — Arranges semantic wheel values in a front/rear axle layout.
 * Live telemetry uses LiveTelemetryView; analysis/replay uses SemanticAnalysisFrame.
 */
export function TireDiagram({ frame, view, gameId }: { frame?: SemanticAnalysisFrame; view?: LiveTelemetryView; gameId?: Parameters<typeof getGame>[0] }) {
  if (frame) {
    const semanticGameId = view?.simulator ?? gameId;
    return semanticGameId ? <SemanticTireDiagram frame={frame} gameId={semanticGameId} /> : null;
  }
  if (!view) return null;
  const t = view.tires;
  const adapter = getGame(view.simulator);
  return (
    <TireGrid
      fl={{ tempC: t.temperatureC?.fl, wear: t.wear?.fl }}
      fr={{ tempC: t.temperatureC?.fr, wear: t.wear?.fr }}
      rl={{ tempC: t.temperatureC?.rl, wear: t.wear?.rl }}
      rr={{ tempC: t.temperatureC?.rr, wear: t.wear?.rr }}
      healthThresholds={adapter.tireHealthThresholds ?? { green: 0.7, yellow: 0.4 }}
      tempThresholds={{ blue: 60, orange: 85, red: 100 }}
      temperatureAvailable={t.temperatureC !== undefined}
      healthAvailable={t.wear !== undefined}
    />
  );
}
