import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { resolveWheelMetric } from "../../../../shared/racing/analysis/metric-values";
import type { GameId } from "../../../../shared/games/ids";
import { useTirePressureOptimal } from "../../hooks/catalog-queries";
import type { useUnits } from "../../hooks/useUnits";
import { brakeTempColor, tireHealthColor, tirePressureColor, tireTempColor, wearRateColor } from "../../lib/vehicle-dynamics";
import { convertTemp } from "../../lib/temperature";
import { m } from "../../paraglide/messages";
import { WheelTable } from "./WheelTable";
import type { SemanticAnalysisFrame } from "./track-map/types";

interface WearRate { FL: number; FR: number; RL: number; RR: number; }
interface Props { frame: SemanticAnalysisFrame; gameId: GameId; units: ReturnType<typeof useUnits>; wearRate: WearRate | null; }
const WHEELS = ["FL", "FR", "RL", "RR"] as const;
const unavailable = <span className="text-app-text-dim">—</span>;
const values = (frame: SemanticAnalysisFrame, id: string): (number | null)[] => {
  const value = frame.values[id];
  return WHEELS.map((_, index) => Array.isArray(value) && typeof value[index] === "number" && Number.isFinite(value[index]) ? value[index] : null);
};

export function AnalyseTireWheelsPanel({ frame, gameId, units, wearRate }: Props) {
  const adapter = getGame(gameId);
  const analysis = resolveAnalysisTelemetry(adapter);
  const binding = (metric: typeof analysis.tireTemperature) => metric.source !== "unavailable" && metric.binding?.kind === "value" ? metric.binding : undefined;
  const temp = binding(analysis.tireTemperature) ? resolveWheelMetric(frame, binding(analysis.tireTemperature)!) : [null, null, null, null];
  const health = binding(analysis.tireHealth) ? resolveWheelMetric(frame, binding(analysis.tireHealth)!) : [null, null, null, null];
  const speed = binding(analysis.wheelRotation) ? resolveWheelMetric(frame, binding(analysis.wheelRotation)!) : [null, null, null, null];
  const brake = values(frame, "brakes.brake-temp");
  const pressure = binding(analysis.tirePressure) ? resolveWheelMetric(frame, binding(analysis.tirePressure)!) : [null, null, null, null];
  const optimal = useTirePressureOptimal(gameId, typeof frame.values["identity.car-ordinal"] === "number" ? frame.values["identity.car-ordinal"] : 0);
  const hThresholds = adapter.tireHealthThresholds ?? { green: 0.7, yellow: 0.4 };
  const tempCell = (value: number | null) => value == null ? unavailable : <span style={{ color: tireTempColor(value, units.thresholds) }}>{`${convertTemp(value, units.temperatureUnit, "C").toFixed(0)}${units.tempLabel}`}</span>;
  const pitTemperature = analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot";
  const pitHealth = analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot";
  const coldPressure = analysis.tirePressure.source !== "unavailable" && analysis.tirePressure.display === "cold-pressure";
  const rows = [
    { label: m.analyse_wheels_rotation_s(), fl: speed[0]?.toFixed(1) ?? unavailable, fr: speed[1]?.toFixed(1) ?? unavailable, rl: speed[2]?.toFixed(1) ?? unavailable, rr: speed[3]?.toFixed(1) ?? unavailable },
    { label: pitTemperature ? m.analyse_wheels_pit_temp() : m.analyse_wheels_temp(), fl: tempCell(temp[0]), fr: tempCell(temp[1]), rl: tempCell(temp[2]), rr: tempCell(temp[3]) },
    { label: pitHealth ? m.analyse_wheels_pit_health() : m.analyse_wheels_health(), fl: health[0] == null ? unavailable : <span style={{ color: tireHealthColor(health[0], hThresholds) }}>{`${((1 - health[0]) * 100).toFixed(1)}%`}</span>, fr: health[1] == null ? unavailable : <span style={{ color: tireHealthColor(health[1], hThresholds) }}>{`${((1 - health[1]) * 100).toFixed(1)}%`}</span>, rl: health[2] == null ? unavailable : <span style={{ color: tireHealthColor(health[2], hThresholds) }}>{`${((1 - health[2]) * 100).toFixed(1)}%`}</span>, rr: health[3] == null ? unavailable : <span style={{ color: tireHealthColor(health[3], hThresholds) }}>{`${((1 - health[3]) * 100).toFixed(1)}%`}</span> },
    ...(wearRate && analysis.tireWearRate.source !== "unavailable" ? [{ label: m.analyse_wheels_wear_s(), fl: <span style={{ color: wearRateColor(wearRate.FL * 100) }}>{`${(wearRate.FL * 100).toFixed(3)}%`}</span>, fr: <span style={{ color: wearRateColor(wearRate.FR * 100) }}>{`${(wearRate.FR * 100).toFixed(3)}%`}</span>, rl: <span style={{ color: wearRateColor(wearRate.RL * 100) }}>{`${(wearRate.RL * 100).toFixed(3)}%`}</span>, rr: <span style={{ color: wearRateColor(wearRate.RR * 100) }}>{`${(wearRate.RR * 100).toFixed(3)}%`}</span> }] : []),
    ...(brake.some((value) => value != null) ? [{ label: m.analyse_wheels_brake(), fl: brake[0] == null ? unavailable : <span style={{ color: brakeTempColor(brake[0], false) }}>{`${brake[0].toFixed(0)}°C`}</span>, fr: brake[1] == null ? unavailable : <span style={{ color: brakeTempColor(brake[1], false) }}>{`${brake[1].toFixed(0)}°C`}</span>, rl: brake[2] == null ? unavailable : <span style={{ color: brakeTempColor(brake[2], true) }}>{`${brake[2].toFixed(0)}°C`}</span>, rr: brake[3] == null ? unavailable : <span style={{ color: brakeTempColor(brake[3], true) }}>{`${brake[3].toFixed(0)}°C`}</span> }] : []),
    ...(pressure.some((value) => value != null) ? [{ label: coldPressure ? m.analyse_wheels_cold_pressure() : m.analyse_wheels_pressure(), fl: pressure[0] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[0], optimal) }}>{`${pressure[0].toFixed(1)} psi`}</span>, fr: pressure[1] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[1], optimal) }}>{`${pressure[1].toFixed(1)} psi`}</span>, rl: pressure[2] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[2], optimal) }}>{`${pressure[2].toFixed(1)} psi`}</span>, rr: pressure[3] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[3], optimal) }}>{`${pressure[3].toFixed(1)} psi`}</span> }] : []),
  ];
  return <div className="text-app-compact font-mono"><WheelTable title={m.analyse_wheels_wheels()} borderTop rows={rows as never} /></div>;
}
