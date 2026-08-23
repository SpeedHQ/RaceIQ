import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { resolveGripDemand, resolveWheelMetric } from "@shared/racing/analysis/metric-values";
import { useEffect, useRef, useState } from "react";
import { useUnits } from "@/hooks/useUnits";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import { controlInputPercent } from "@/lib/vehicle-dynamics";
import type { SemanticMetricFrame } from "../../../../shared/racing/analysis/metric-values";

import { GRIP_MAX_SAMPLES } from "./GripSparkline";
import { DualLineChart, FourLineChart, SingleLineChart } from "./MiniCharts";

/**
 * TelemetryCharts — Aggregates all rolling 60s time-series data into chart components.
 * Downsamples from 60Hz to ~10Hz (every 6th frame) to keep buffers at 600 samples.
 * Seeds from server on mount so charts populate immediately after page refresh.
 * Converts raw telemetry units (rad->deg, m/s->mph, 0-255->0-100%) for display.
 */
export function TelemetryCharts({ view }: { view: LiveTelemetryView }) {
  const units = useUnits();
  const analysis = resolveAnalysisTelemetry(getGame(view.simulator));
  const showGrip = analysis.gripDemand.source !== "unavailable";
  const showTemperature = analysis.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "continuous";
  const showWear = analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "continuous";
  const showSlipAngle = analysis.slipAngle.source !== "unavailable";
  const showSlipRatio = analysis.slipRatio.source !== "unavailable";
  const showNormalizedSuspension = analysis.suspensionTravel.source !== "unavailable" && analysis.suspensionTravel.display !== "millimeters";
  const histRef = useRef({
    grip: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    temp: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    wear: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    slipAngle: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    slipRatio: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    suspension: { fl: [] as number[], fr: [] as number[], rl: [] as number[], rr: [] as number[] },
    throttle: [] as number[],
    brake: [] as number[],
    speed: [] as number[],
  });
  const frameRef = useRef(0);
  const [chartData, setChartData] = useState(histRef.current);

  useEffect(() => {
    frameRef.current++;
    if (frameRef.current % 6 !== 0) return;
    const history = histRef.current;
    const asArray = (values: LiveTelemetryView["tires"]["combinedSlip"]) => (values ? [values.fl, values.fr, values.rl, values.rr] : undefined);
    const semanticFrame: SemanticMetricFrame = {
      values: {
        "tires.tire-combined-slip": asArray(view.tires.combinedSlip),
        "tire.temperature.average": asArray(view.tires.temperatureC),
        "tires.tire-wear": asArray(view.tires.wear),
        "tires.tire-slip-angle": asArray(view.tires.slipAngleRad),
        "tires.tire-slip-ratio": asArray(view.tires.slipRatio),
        "suspension.norm-suspension-travel": asArray(view.tires.suspensionNormalized),
      },
    };
    const metricValues = (key: "combinedSlip" | "temperatureC" | "wear" | "slipAngleRad" | "slipRatio" | "suspensionNormalized") => {
      const metric =
        key === "combinedSlip"
          ? analysis.gripDemand
          : key === "temperatureC"
            ? analysis.tireTemperature
            : key === "wear"
              ? analysis.tireHealth
              : key === "slipAngleRad"
                ? analysis.slipAngle
                : key === "slipRatio"
                  ? analysis.slipRatio
                  : analysis.suspensionTravel;
      if (metric.source === "unavailable") return null;
      return key === "combinedSlip" ? resolveGripDemand(semanticFrame, metric) : metric.binding?.kind === "value" ? resolveWheelMetric(semanticFrame, metric.binding) : null;
    };
    const appendWheel = (target: { fl: number[]; fr: number[]; rl: number[]; rr: number[] }, values: readonly (number | null)[] | null, convert: (value: number) => number) => {
      if (!values || values.length < 4 || !values.slice(0, 4).every((value) => typeof value === "number" && Number.isFinite(value))) return;
      target.fl.push(convert(values[0] as number));
      target.fr.push(convert(values[1] as number));
      target.rl.push(convert(values[2] as number));
      target.rr.push(convert(values[3] as number));
      if (target.fl.length > GRIP_MAX_SAMPLES) {
        target.fl.shift();
        target.fr.shift();
        target.rl.shift();
        target.rr.shift();
      }
    };
    appendWheel(history.grip, metricValues("combinedSlip"), Math.abs);
    appendWheel(history.temp, metricValues("temperatureC"), (value) => value);
    appendWheel(history.wear, metricValues("wear"), (value) => value);
    appendWheel(history.slipAngle, metricValues("slipAngleRad"), (value) => value * (180 / Math.PI));
    appendWheel(history.slipRatio, metricValues("slipRatio"), Math.abs);
    appendWheel(history.suspension, metricValues("suspensionNormalized"), (value) => value);
    if (view.inputs.throttle !== undefined) history.throttle.push(controlInputPercent(view.inputs.throttle));
    if (view.inputs.brake !== undefined) history.brake.push(controlInputPercent(view.inputs.brake));
    if (view.motion.speedMps !== undefined) history.speed.push(units.speed(view.motion.speedMps));
    for (const series of [history.throttle, history.brake, history.speed]) {
      if (series.length > GRIP_MAX_SAMPLES) series.shift();
    }
    setChartData({ ...history });
  }, [analysis, units, view]);

  return (
    <div className="grid gap-2">
      {showGrip && <FourLineChart data={chartData.grip} label="Combined Slip" maxY={3} />}
      {showTemperature && <FourLineChart data={chartData.temp} label="Tire Temp" unit="°" />}
      {showWear && <FourLineChart data={chartData.wear} label="Tire Wear" maxY={1} />}
      {showSlipAngle && <FourLineChart data={chartData.slipAngle} label="Slip Angle" unit="°" />}
      {showSlipRatio && <FourLineChart data={chartData.slipRatio} label="Slip Ratio" />}
      {showNormalizedSuspension && <FourLineChart data={chartData.suspension} label="Suspension" maxY={1} />}
      <SingleLineChart data={chartData.speed} label={`Speed (${units.speedLabel})`} color="var(--app-accent)" />
      <DualLineChart data1={chartData.throttle} data2={chartData.brake} label1="Throttle" label2="Brake" color1="var(--ch-throttle)" color2="var(--ch-brake)" label="Throttle / Brake" maxY={100} />
    </div>
  );
}
