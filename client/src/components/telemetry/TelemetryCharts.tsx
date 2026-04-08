import { useEffect, useRef, useState } from "react";
import type { DisplayPacket } from "@/lib/convert-packet";
import { client } from "@/lib/rpc";
import { GRIP_MAX_SAMPLES } from "./GripSparkline";
import { FourLineChart, SingleLineChart, DualLineChart } from "./MiniCharts";

/**
 * TelemetryCharts — Aggregates all rolling 60s time-series data into chart components.
 * Downsamples from 60Hz to ~10Hz (every 6th frame) to keep buffers at 600 samples.
 * Seeds from server on mount so charts populate immediately after page refresh.
 * Converts raw telemetry units (rad->deg, m/s->mph, 0-255->0-100%) for display.
 */
export function TelemetryCharts({ packet }: { packet: DisplayPacket }) {
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
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    client.api["telemetry-history"].$get()
      .then((r) => r.json() as Promise<typeof histRef.current>)
      .then((data) => {
        if (data && Array.isArray(data.grip?.fl)) {
          histRef.current = data;
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
    throttle: [] as number[], brake: [] as number[], speed: [] as number[],
  });

  // Sample at ~10Hz
  useEffect(() => {
    frameRef.current++;
    if (frameRef.current % 6 !== 0) return;

    const h = histRef.current;
    const push4 = (t: { fl: number[]; fr: number[]; rl: number[]; rr: number[] }, fl: number, fr: number, rl: number, rr: number) => {
      t.fl.push(fl); t.fr.push(fr); t.rl.push(rl); t.rr.push(rr);
      if (t.fl.length > GRIP_MAX_SAMPLES) { t.fl.shift(); t.fr.shift(); t.rl.shift(); t.rr.shift(); }
    };
    push4(h.grip, Math.abs(packet.TireCombinedSlipFL), Math.abs(packet.TireCombinedSlipFR), Math.abs(packet.TireCombinedSlipRL), Math.abs(packet.TireCombinedSlipRR));
    push4(h.temp, packet.TireTempFL, packet.TireTempFR, packet.TireTempRL, packet.TireTempRR);
    push4(h.wear, packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR);
    push4(h.slipAngle, packet.TireSlipAngleFL * (180 / Math.PI), packet.TireSlipAngleFR * (180 / Math.PI), packet.TireSlipAngleRL * (180 / Math.PI), packet.TireSlipAngleRR * (180 / Math.PI));
    push4(h.slipRatio, Math.abs(packet.TireSlipRatioFL), Math.abs(packet.TireSlipRatioFR), Math.abs(packet.TireSlipRatioRL), Math.abs(packet.TireSlipRatioRR));
    push4(h.suspension, packet.NormSuspensionTravelFL, packet.NormSuspensionTravelFR, packet.NormSuspensionTravelRL, packet.NormSuspensionTravelRR);
    h.throttle.push(packet.Accel / 255 * 100);
    h.brake.push(packet.Brake / 255 * 100);
    h.speed.push(packet.DisplaySpeed);
    if (h.throttle.length > GRIP_MAX_SAMPLES) { h.throttle.shift(); h.brake.shift(); h.speed.shift(); }
    setChartData({ ...h });
  }, [packet]);

  return (
    <div className="grid gap-2">
      <FourLineChart data={chartData.grip} label="Combined Slip" maxY={3} />
      <FourLineChart data={chartData.temp} label="Tire Temp" unit="°" />
      <FourLineChart data={chartData.wear} label="Tire Wear" maxY={1} />
      <FourLineChart data={chartData.slipAngle} label="Slip Angle" unit="°" />
      <FourLineChart data={chartData.slipRatio} label="Slip Ratio" />
      <FourLineChart data={chartData.suspension} label="Suspension" maxY={1} />
      <SingleLineChart data={chartData.speed} label="Speed" color="#22d3ee" />
      <DualLineChart data1={chartData.throttle} data2={chartData.brake} label1="Throttle" label2="Brake" color1="#34d399" color2="#ef4444" label="Throttle / Brake" maxY={100} />
    </div>
  );
}
