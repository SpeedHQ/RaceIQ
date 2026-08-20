import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
import { syncCanvasSize } from "@/lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { controlInputPercent } from "@/lib/vehicle-dynamics";
import type { SemanticAnalysisFrame } from "./AnalyseSegmentList";
import { m } from "../../paraglide/messages";
import { TelemetryChart } from "./AnalyseTelemetryChart";

export interface ChartData {
  speed: number[];
  throttle: number[];
  brake: number[];
  rpm: number[];
  steering: number[];
  timeFracs: number[];
  times: number[];
  tireTempFL: number[];
  tireTempFR: number[];
  tireTempRL: number[];
  tireTempRR: number[];
  drs?: number[];
  ersStore?: number[];
  ersDeployed?: number[];
  brakeTempFL?: number[];
  brakeTempFR?: number[];
  brakeTempRL?: number[];
  brakeTempRR?: number[];
}

export interface ChartsPanelHandle {
  timeFracs: number[] | null;
  times: number[] | null;
  updateCursor: (idx: number) => void;
}

interface ChartsPanelProps {
  displayTelemetry: SemanticAnalysisFrame[];
  totalPackets: number;
  visualTimeFrac: number | null;
  onVisualFracChange: (frac: number | null) => void;
  onClickIndex: (idx: number) => void;
  onScrubStart: () => void;
  speedLabel: string;
  tempLabel: string;
}

const numeric = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => { const value = frame.values[id];
return typeof value === "number" && Number.isFinite(value) ? value : null; }

const wheel = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"], index: number): number | null => { const value = frame.values[id];
if (Array.isArray(value)) {
  const item = value[index];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}
return numeric(frame, id); }

function buildChartData(displayTelemetry: SemanticAnalysisFrame[]): ChartData | null {
  if (displayTelemetry.length === 0) return null;
  const speed: number[] = [], throttle: number[] = [], brake: number[] = [], rpm: number[] = [], steering: number[] = [];
  const tireTempFL: number[] = [], tireTempFR: number[] = [], tireTempRL: number[] = [], tireTempRR: number[] = [];
  const times = displayTelemetry.map((p) => numeric(p, "timing.current-lap") ?? NaN);
  const firstTime = times[0];
  const maxTime = Math.max(...times.filter(Number.isFinite), firstTime);
  const lapDuration = maxTime - firstTime || 1;
  const timeFracs = times.map((time, i) => (Number.isFinite(time) ? Math.max(i ? 0 : 0, (time - firstTime) / lapDuration) : NaN));
  let hasBrakeTemp = false;
  const brakeTempFL: number[] = [], brakeTempFR: number[] = [], brakeTempRL: number[] = [], brakeTempRR: number[] = [];
  for (const frame of displayTelemetry) {
    speed.push(numeric(frame, "motion.speed") ?? NaN);
    const throttleRatio = numeric(frame, "inputs.throttle");
    const brakeRatio = numeric(frame, "inputs.brake");
    throttle.push(throttleRatio == null ? NaN : controlInputPercent(throttleRatio));
    brake.push(brakeRatio == null ? NaN : controlInputPercent(brakeRatio));
    rpm.push(numeric(frame, "engine.current-engine-rpm") ?? NaN);
    steering.push(numeric(frame, "inputs.steering") ?? NaN);
    tireTempFL.push(wheel(frame, "tire.temperature.average", 0) ?? NaN);
    tireTempFR.push(wheel(frame, "tire.temperature.average", 1) ?? NaN);
    tireTempRL.push(wheel(frame, "tire.temperature.average", 2) ?? NaN);
    tireTempRR.push(wheel(frame, "tire.temperature.average", 3) ?? NaN);
    const brakes = (["brakes.brake-temp", "brakes.brake-temp", "brakes.brake-temp", "brakes.brake-temp"] as const).map((id, i) => wheel(frame, id, i));
    brakeTempFL.push(brakes[0] ?? NaN); brakeTempFR.push(brakes[1] ?? NaN); brakeTempRL.push(brakes[2] ?? NaN); brakeTempRR.push(brakes[3] ?? NaN);
    if (brakes.some((value) => value != null)) hasBrakeTemp = true;
  }
  return { speed, throttle, brake, rpm, steering, timeFracs, times, tireTempFL, tireTempFR, tireTempRL, tireTempRR,
    ...(hasBrakeTemp ? { brakeTempFL, brakeTempFR, brakeTempRL, brakeTempRR } : {}) };
}

export const AnalyseChartsPanel = memo(
  forwardRef<ChartsPanelHandle, ChartsPanelProps>(function AnalyseChartsPanel(
    { displayTelemetry, totalPackets, visualTimeFrac, onVisualFracChange, onClickIndex, onScrubStart, speedLabel, tempLabel },
    ref,
  ) {
    const chartData = useMemo(() => buildChartData(displayTelemetry), [displayTelemetry]);
    const scrollRef = useRef<HTMLDivElement>(null);
    const cursorOverlayRef = useRef<HTMLCanvasElement>(null);

    // Keep a ref so the imperative handle always returns current data
    const chartDataRef = useRef(chartData);
    chartDataRef.current = chartData;

    // Draw a single shared cursor line across all charts
    const drawSharedCursor = useCallback(
      (idx: number) => {
        const overlay = cursorOverlayRef.current;
        const scroll = scrollRef.current;
        if (!overlay || !scroll) return;

        const w = scroll.clientWidth;
        const h = scroll.scrollHeight;
        if (w <= 0 || h <= 0) return;
        syncCanvasSize(overlay, w, h, window.devicePixelRatio || 1);
        const ctx = getSemanticCanvasContext(overlay);
        if (!ctx) return;
        ctx.setTransform(overlay.width / w, 0, 0, overlay.height / h, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const timeFracs = chartDataRef.current?.timeFracs;
        const totalPackets = displayTelemetry.length;
        if (totalPackets < 2) return;

        const xFrac = timeFracs && idx < timeFracs.length ? timeFracs[idx] : idx / (totalPackets - 1);

        // Chart canvases live inside a parent with `p-3` padding (12px each
        // side), so the overlay — which stretches edge-to-edge of the scroll
        // container — must add that container padding to the chart's own
        // leftPad/rightPad to land exactly where the chart data draws.
        const CONTAINER_PAD = 12; // p-3
        const CHART_LEFT_PAD = 40;
        const CHART_RIGHT_PAD = 8;
        const leftPad = CONTAINER_PAD + CHART_LEFT_PAD;
        const rightPad = CONTAINER_PAD + CHART_RIGHT_PAD;
        const chartW = w - leftPad - rightPad;
        const MIN_INSET = 2;
        const rawCx = leftPad + xFrac * chartW;
        const cx = Math.max(rawCx, leftPad + MIN_INSET);

        // Draw a single vertical line spanning the full scroll height
        ctx.strokeStyle = "color-mix(in srgb, var(--app-text) 50%, transparent)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
        ctx.setLineDash([]);
      },
      [displayTelemetry.length],
    );

    useImperativeHandle(
      ref,
      () => ({
        get timeFracs() {
          return chartDataRef.current?.timeFracs ?? null;
        },
        get times() {
          return chartDataRef.current?.times ?? null;
        },
        updateCursor: drawSharedCursor,
      }),
      [drawSharedCursor],
    );

    if (!chartData) return null;

    const common = {
      totalPackets,
      timeFracs: chartData.timeFracs,
      times: chartData.times,
      visualTimeFrac,
      onVisualFracChange,
      onClickIndex,
      onScrubStart,
    };

    return (
      <div className="relative flex-none overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-y-auto" ref={scrollRef}>
        <canvas ref={cursorOverlayRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 10 }} />
        <div className="p-3 space-y-2">
          <TelemetryChart series={[{ data: chartData.speed, color: "var(--telemetry-speed)", label: `${m.label_speed()} (${speedLabel})` }]} {...common} height={100} />
          <TelemetryChart
            series={[
              { data: chartData.throttle, color: "var(--ch-throttle)", label: "Throttle %" },
              { data: chartData.brake, color: "var(--ch-brake)", label: "Brake %" },
            ]}
            {...common}
            height={100}
          />
          <TelemetryChart series={[{ data: chartData.rpm, color: "var(--telemetry-rpm)", label: m.dataguide_rpm() }]} {...common} height={100} />
          <TelemetryChart series={[{ data: chartData.steering, color: "var(--telemetry-steering)", label: "Steering" }]} {...common} height={80} />
          {chartData.drs && <TelemetryChart series={[{ data: chartData.drs, color: "var(--telemetry-drs)", label: "DRS" }]} {...common} height={40} />}
          {chartData.ersStore && chartData.ersDeployed && (
            <TelemetryChart
              series={[
                { data: chartData.ersStore, color: "var(--telemetry-ers-store)", label: "ERS Store %" },
                { data: chartData.ersDeployed, color: "var(--telemetry-ers-deployed)", label: "ERS Deployed %" },
              ]}
              {...common}
              height={80}
            />
          )}
          <TelemetryChart
            series={[
              { data: chartData.tireTempFL, color: WHEEL_COLOR_VARS[0], label: `Tire FL ${tempLabel}` },
              { data: chartData.tireTempFR, color: WHEEL_COLOR_VARS[1], label: `Tire FR ${tempLabel}` },
              { data: chartData.tireTempRL, color: WHEEL_COLOR_VARS[2], label: `Tire RL ${tempLabel}` },
              { data: chartData.tireTempRR, color: WHEEL_COLOR_VARS[3], label: `Tire RR ${tempLabel}` },
            ]}
            {...common}
            height={80}
          />
          {chartData.brakeTempFL && chartData.brakeTempFR && chartData.brakeTempRL && chartData.brakeTempRR && (
            <TelemetryChart
              series={[
                { data: chartData.brakeTempFL, color: WHEEL_COLOR_VARS[0], label: "Brake FL °C" },
                { data: chartData.brakeTempFR, color: WHEEL_COLOR_VARS[1], label: "Brake FR °C" },
                { data: chartData.brakeTempRL, color: WHEEL_COLOR_VARS[2], label: "Brake RL °C" },
                { data: chartData.brakeTempRR, color: WHEEL_COLOR_VARS[3], label: "Brake RR °C" },
              ]}
              {...common}
              height={80}
            />
          )}
        </div>
      </div>
    );
  }),
);
