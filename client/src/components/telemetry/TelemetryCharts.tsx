import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import { resolveGripDemand, resolveWheelMetric } from "@shared/racing/analysis/metric-values";
import { useEffect, useRef, useState } from "react";
import type { DisplayPacket } from "@/lib/convert-packet";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import { client } from "@/lib/rpc";
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
export function TelemetryCharts({ packet, view }: { packet?: DisplayPacket; view?: LiveTelemetryView }) {
  const gameId = view?.simulator ?? packet?.gameId;
  const analysis = gameId ? resolveAnalysisTelemetry(getGame(gameId)) : null;
  const showGrip = analysis?.gripDemand.source !== "unavailable";
  const showTemperature = analysis?.tireTemperature.source === "direct" && analysis.tireTemperature.freshness === "continuous";
  const showWear = analysis?.tireHealth.source === "direct" && analysis.tireHealth.freshness === "continuous";
  const showSlipAngle = analysis?.slipAngle.source !== "unavailable";
  const showSlipRatio = analysis?.slipRatio.source !== "unavailable";
  const showNormalizedSuspension = analysis?.suspensionTravel.source !== "unavailable" && analysis?.suspensionTravel.display !== "millimeters";
  const histRef = useRef<{
    grip: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    temp: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    wear: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    slipAngle: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    slipRatio: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    suspension: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
    throttle: number[];
    brake: number[];
    speed: number[];
  }>({
    grip: { fl: [], fr: [], rl: [], rr: [] },
    temp: { fl: [], fr: [], rl: [], rr: [] },
    wear: { fl: [], fr: [], rl: [], rr: [] },
    slipAngle: { fl: [], fr: [], rl: [], rr: [] },
    slipRatio: { fl: [], fr: [], rl: [], rr: [] },
    suspension: { fl: [], fr: [], rl: [], rr: [] },
    throttle: [],
    brake: [],
    speed: [],
  });
  const frameRef = useRef(0);
  const fetchedRef = useRef(false);

  // Seed from server
  useEffect(() => {
    if (!gameId || !analysis) return;
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["telemetry-history"]
      .$get()
      .then((r) => r.json() as Promise<typeof histRef.current>)
      .then((data) => {
        if (data && Array.isArray(data.grip?.fl)) {
          histRef.current = { ...data, temp: { fl: [], fr: [], rl: [], rr: [] } };
        }
      })
      .catch(() => {});
  }, []);

  const [chartData, setChartData] = useState({
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

  // Sample at ~10Hz
  useEffect(() => {
    frameRef.current++;
    if (frameRef.current % 6 !== 0) return;
    if (!gameId || !analysis) return;
    const activeAnalysis = analysis;

    const h = histRef.current;
    const push4 = (t: { fl: number[]; fr: number[]; rl: number[]; rr: number[] }, fl: number, fr: number, rl: number, rr: number) => {
      t.fl.push(fl);
      t.fr.push(fr);
      t.rl.push(rl);
      t.rr.push(rr);
      if (t.fl.length > GRIP_MAX_SAMPLES) {
        t.fl.shift();
        t.fr.shift();
        t.rl.shift();
        t.rr.shift();
      }
    };
    const semanticFrame: SemanticMetricFrame | null = view ? {
      values: {
        "tires.tire-combined-slip": view.tires.combinedSlip,
        "tire.temperature.average": view.tires.temperatureC,
        "tires.tire-wear": view.tires.wear,
        "tires.tire-slip-angle": view.tires.slipAngleRad,
        "tires.tire-slip-ratio": view.tires.slipRatio,
        "suspension.norm-suspension-travel": view.tires.suspensionNormalized,
      },
    } : packet ? {
      values: {
        "tires.tire-combined-slip": [packet.TireCombinedSlipFL, packet.TireCombinedSlipFR, packet.TireCombinedSlipRL, packet.TireCombinedSlipRR],
        "tire.temperature.average": [packet.TireTempFL, packet.TireTempFR, packet.TireTempRL, packet.TireTempRR].map((value) => gameId === "fm-2023" ? (value - 32) * 5 / 9 : value),
        "tires.tire-wear": [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR],
        "tires.tire-slip-angle": [packet.TireSlipAngleFL, packet.TireSlipAngleFR, packet.TireSlipAngleRL, packet.TireSlipAngleRR],
        "tires.tire-slip-ratio": [packet.TireSlipRatioFL, packet.TireSlipRatioFR, packet.TireSlipRatioRL, packet.TireSlipRatioRR],
        "suspension.norm-suspension-travel": [packet.NormSuspensionTravelFL, packet.NormSuspensionTravelFR, packet.NormSuspensionTravelRL, packet.NormSuspensionTravelRR],
      },
    } : null;
    const metricBinding = (key: "combinedSlip" | "temperatureC" | "wear" | "slipAngleRad" | "slipRatio" | "suspensionNormalized") => {
      const metric = key === "combinedSlip" ? activeAnalysis.gripDemand : key === "temperatureC" ? activeAnalysis.tireTemperature : key === "wear" ? activeAnalysis.tireHealth : key === "slipAngleRad" ? activeAnalysis.slipAngle : key === "slipRatio" ? activeAnalysis.slipRatio : activeAnalysis.suspensionTravel;
      if (!semanticFrame || metric.source === "unavailable") return null;
      if (key === "combinedSlip") return resolveGripDemand(semanticFrame, metric);
      return metric.binding?.kind === "value" ? resolveWheelMetric(semanticFrame, metric.binding) : null;
    };
    const wheel = (key: "combinedSlip" | "temperatureC" | "wear" | "slipAngleRad" | "slipRatio" | "suspensionNormalized") => {
      const resolved = metricBinding(key);
      return resolved
        ? { fl: resolved[0] ?? 0, fr: resolved[1] ?? 0, rl: resolved[2] ?? 0, rr: resolved[3] ?? 0 }
        : { fl: 0, fr: 0, rl: 0, rr: 0 };
    };
    const grip = wheel("combinedSlip"), temp = wheel("temperatureC"), wear = wheel("wear"), angle = wheel("slipAngleRad"), ratio = wheel("slipRatio"), suspension = wheel("suspensionNormalized");
    push4(h.grip, Math.abs(grip.fl), Math.abs(grip.fr), Math.abs(grip.rl), Math.abs(grip.rr));
    push4(h.temp, temp.fl, temp.fr, temp.rl, temp.rr);
    push4(h.wear, wear.fl, wear.fr, wear.rl, wear.rr);
    push4(h.slipAngle, angle.fl * (180 / Math.PI), angle.fr * (180 / Math.PI), angle.rl * (180 / Math.PI), angle.rr * (180 / Math.PI));
    push4(h.slipRatio, Math.abs(ratio.fl), Math.abs(ratio.fr), Math.abs(ratio.rl), Math.abs(ratio.rr));
    push4(h.suspension, suspension.fl, suspension.fr, suspension.rl, suspension.rr);
    h.throttle.push(controlInputPercent(view?.inputs.throttle ?? packet?.Accel));
    h.brake.push(controlInputPercent(view?.inputs.brake ?? packet?.Brake));
    h.speed.push(view?.motion.speedMps ?? packet?.DisplaySpeed ?? 0);
    if (h.throttle.length > GRIP_MAX_SAMPLES) {
      h.throttle.shift();
      h.brake.shift();
      h.speed.shift();
    }
    setChartData({ ...h });
  }, [packet, view?.sequence, view?.streamId]);

  if (!gameId || !analysis) return null;

  return (
    <div className="grid gap-2">
      {showGrip && <FourLineChart data={chartData.grip} label="Combined Slip" maxY={3} />}
      {showTemperature && <FourLineChart data={chartData.temp} label="Tire Temp" unit="°" />}
      {showWear && <FourLineChart data={chartData.wear} label="Tire Wear" maxY={1} />}
      {showSlipAngle && <FourLineChart data={chartData.slipAngle} label="Slip Angle" unit="°" />}
      {showSlipRatio && <FourLineChart data={chartData.slipRatio} label="Slip Ratio" />}
      {showNormalizedSuspension && <FourLineChart data={chartData.suspension} label="Suspension" maxY={1} />}
      <SingleLineChart data={chartData.speed} label="Speed" color="var(--app-accent)" />
      <DualLineChart data1={chartData.throttle} data2={chartData.brake} label1="Throttle" label2="Brake" color1="var(--ch-throttle)" color2="var(--ch-brake)" label="Throttle / Brake" maxY={100} />
    </div>
  );
}
