import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { resolveWheelMetric } from "../../../../shared/racing/analysis/metric-values";
import type { GameId } from "../../../../shared/games/ids";
import { useTirePressureOptimal } from "../../hooks/catalog-queries";
import type { useUnits } from "../../hooks/useUnits";
import { brakeTempColor, tireHealthColor, tirePressureColor, tireTempColor, wearRateColor } from "../../lib/vehicle-dynamics";
import { m } from "../../paraglide/messages";
import { WheelTable } from "./WheelTable";
import { hasSurfaceTemperatureProfile } from "./tire-temperature-profile";
import { semanticWheelNumbers, type SemanticAnalysisFrame } from "./track-map/types";
interface WearRate {
  FL: number;
  FR: number;
  RL: number;
  RR: number;
}
interface Props {
  frame: SemanticAnalysisFrame;
  gameId: GameId;
  units: ReturnType<typeof useUnits>;
  wearRate: WearRate | null;
}
const unavailable = <span className="text-app-text-dim">—</span>;

export function AnalyseTireWheelsPanel({ frame, gameId, units, wearRate }: Props) {
  const adapter = getGame(gameId);
  const analysis = resolveAnalysisTelemetry(adapter);
  const binding = (metric: typeof analysis.tireTemperature) => (metric.source !== "unavailable" && metric.binding?.kind === "value" ? metric.binding : undefined);
  const temp = binding(analysis.tireTemperature) ? resolveWheelMetric(frame, binding(analysis.tireTemperature)!) : [null, null, null, null];
  const coreTemp = semanticWheelNumbers(frame, "tire.temperature.core");
  const dualTemperature = analysis.tireTemperature.source !== "unavailable"
    && analysis.tireTemperature.binding?.kind === "value"
    && analysis.tireTemperature.binding.semanticId === "tire.temperature.surface.representative"
    && temp.some((value) => value != null)
    && coreTemp.some((value) => value != null);
  const health = binding(analysis.tireHealth) ? resolveWheelMetric(frame, binding(analysis.tireHealth)!) : [null, null, null, null];
  const speed = binding(analysis.wheelRotation) ? resolveWheelMetric(frame, binding(analysis.wheelRotation)!) : [null, null, null, null];
  const brake = semanticWheelNumbers(frame, "brakes.brake-temp");
  const pressure = binding(analysis.tirePressure) ? resolveWheelMetric(frame, binding(analysis.tirePressure)!) : [null, null, null, null];
  const optimal = useTirePressureOptimal(gameId, typeof frame.values["identity.car-ordinal"] === "number" ? frame.values["identity.car-ordinal"] : 0);
  const hThresholds = adapter.tireHealthThresholds ?? { green: 0.7, yellow: 0.4 };
  const tempCell = (value: number | null, wheel: string, band: string) => {
    const text = value == null ? m.analyse_unavailable() : `${units.temp(value).toFixed(0)}${units.tempLabel}`;
    return <span title={`${wheel} ${band}: ${text}`} aria-label={`${wheel} ${band}: ${text}`} style={value == null ? undefined : { color: tireTempColor(value, units.thresholds) }}>{value == null ? unavailable : text}</span>;
  };
  const pitTemperature = analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "pit-snapshot";
  const pitHealth = analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot";
  const coldPressure = analysis.tirePressure.source !== "unavailable" && analysis.tirePressure.display === "cold-pressure";
  const profile = hasSurfaceTemperatureProfile(frame);
  const profileRows = ([
    ["inner", m.label_inner(), semanticWheelNumbers(frame, "tire.temperature.surface.inner")],
    ["middle", m.label_middle(), semanticWheelNumbers(frame, "tire.temperature.surface.middle")],
    ["outer", m.label_outer(), semanticWheelNumbers(frame, "tire.temperature.surface.outer")],
    ["core", m.label_core(), coreTemp],
  ] as const).map(([, label, values]) => ({
    label,
    fl: tempCell(values[0], "FL", label),
    fr: tempCell(values[1], "FR", label),
    rl: tempCell(values[2], "RL", label),
    rr: tempCell(values[3], "RR", label),
  }));
  const rows = [
    { label: m.analyse_wheels_rotation_s(), fl: speed[0]?.toFixed(1) ?? unavailable, fr: speed[1]?.toFixed(1) ?? unavailable, rl: speed[2]?.toFixed(1) ?? unavailable, rr: speed[3]?.toFixed(1) ?? unavailable },
    ...(profile ? profileRows : [{ label: dualTemperature ? m.label_surface() : (pitTemperature ? m.analyse_wheels_pit_temp() : m.analyse_wheels_temp()), fl: tempCell(temp[0], "FL", m.label_surface()), fr: tempCell(temp[1], "FR", m.label_surface()), rl: tempCell(temp[2], "RL", m.label_surface()), rr: tempCell(temp[3], "RR", m.label_surface()) }, ...(dualTemperature ? [{ label: m.label_core(), fl: tempCell(coreTemp[0], "FL", m.label_core()), fr: tempCell(coreTemp[1], "FR", m.label_core()), rl: tempCell(coreTemp[2], "RL", m.label_core()), rr: tempCell(coreTemp[3], "RR", m.label_core()) }] : [])]),
    { label: pitHealth ? m.analyse_wheels_pit_health() : m.analyse_wheels_health(), fl: health[0] == null ? unavailable : <span style={{ color: tireHealthColor(health[0], hThresholds) }}>{`${((1 - health[0]) * 100).toFixed(1)}%`}</span>, fr: health[1] == null ? unavailable : <span style={{ color: tireHealthColor(health[1], hThresholds) }}>{`${((1 - health[1]) * 100).toFixed(1)}%`}</span>, rl: health[2] == null ? unavailable : <span style={{ color: tireHealthColor(health[2], hThresholds) }}>{`${((1 - health[2]) * 100).toFixed(1)}%`}</span>, rr: health[3] == null ? unavailable : <span style={{ color: tireHealthColor(health[3], hThresholds) }}>{`${((1 - health[3]) * 100).toFixed(1)}%`}</span> },
    ...(analysis.tireWearRate.source !== "unavailable" ? [{ label: m.analyse_wheels_wear_s(), fl: <span style={{ color: wearRateColor(wearRate ? wearRate.FL * 100 : null) }}>{wearRate ? `${(wearRate.FL * 100).toFixed(3)}%` : "—"}</span>, fr: <span style={{ color: wearRateColor(wearRate ? wearRate.FR * 100 : null) }}>{wearRate ? `${(wearRate.FR * 100).toFixed(3)}%` : "—"}</span>, rl: <span style={{ color: wearRateColor(wearRate ? wearRate.RL * 100 : null) }}>{wearRate ? `${(wearRate.RL * 100).toFixed(3)}%` : "—"}</span>, rr: <span style={{ color: wearRateColor(wearRate ? wearRate.RR * 100 : null) }}>{wearRate ? `${(wearRate.RR * 100).toFixed(3)}%` : "—"}</span> }] : []),
    ...((brake[0] ?? 0) > 0 || (brake[1] ?? 0) > 0 ? [{ label: m.analyse_wheels_brake(), fl: brake[0] == null ? unavailable : <span style={{ color: brakeTempColor(brake[0], false) }}>{`${units.temp(brake[0]).toFixed(0)}${units.tempLabel}`}</span>, fr: brake[1] == null ? unavailable : <span style={{ color: brakeTempColor(brake[1], false) }}>{`${units.temp(brake[1]).toFixed(0)}${units.tempLabel}`}</span>, rl: brake[2] == null ? unavailable : <span style={{ color: brakeTempColor(brake[2], true) }}>{`${units.temp(brake[2]).toFixed(0)}${units.tempLabel}`}</span>, rr: brake[3] == null ? unavailable : <span style={{ color: brakeTempColor(brake[3], true) }}>{`${units.temp(brake[3]).toFixed(0)}${units.tempLabel}`}</span> }] : []),
    ...((pressure[0] ?? 0) > 0 || (pressure[1] ?? 0) > 0 ? [{ label: coldPressure ? m.analyse_wheels_cold_pressure() : m.analyse_wheels_pressure(), fl: pressure[0] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[0], optimal) }}>{`${pressure[0].toFixed(1)} psi`}</span>, fr: pressure[1] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[1], optimal) }}>{`${pressure[1].toFixed(1)} psi`}</span>, rl: pressure[2] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[2], optimal) }}>{`${pressure[2].toFixed(1)} psi`}</span>, rr: pressure[3] == null ? unavailable : <span style={{ color: coldPressure ? "var(--app-text)" : tirePressureColor(pressure[3], optimal) }}>{`${pressure[3].toFixed(1)} psi`}</span> }] : []),
  ];
  return (
    <div className="text-app-compact font-mono">
      <WheelTable title={m.analyse_wheels_wheels()} borderTop rows={rows as never} />
    </div>
  );
}
