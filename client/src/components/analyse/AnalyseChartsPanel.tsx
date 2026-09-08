import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
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
    throttle.push(numeric(frame, "inputs.accel") ?? NaN);
    brake.push(numeric(frame, "inputs.brake") ?? NaN);
    rpm.push(numeric(frame, "engine.current-engine-rpm") ?? NaN);
    steering.push(numeric(frame, "inputs.steer") ?? NaN);
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
    const cursorLineRef = useRef<HTMLDivElement>(null);
    const chartDataRef = useRef(chartData);
    chartDataRef.current = chartData;

    // Move shared cursor with a DOM style update; canvas resize/redraw per frame
    // made chart scrubbing wait behind a full overlay repaint.
    const drawSharedCursor = useCallback(
      (idx: number) => {
        const line = cursorLineRef.current;
        const scroll = scrollRef.current;
        if (!line || !scroll) return;

        const w = scroll.clientWidth;
        const totalPackets = displayTelemetry.length;
        const timeFracs = chartDataRef.current?.timeFracs;
        if (w <= 0 || totalPackets < 2) {
          line.style.display = "none";
          return;
        }

        const xFrac = timeFracs && idx < timeFracs.length ? timeFracs[idx] : idx / (totalPackets - 1);
        const leftPad = 12 + 40;
        const rightPad = 12 + 8;
        const chartW = w - leftPad - rightPad;
        const cx = Math.max(leftPad + 2, leftPad + xFrac * chartW);
        line.style.display = "";
        line.style.left = `${Math.round(cx)}px`;
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
      visualTimeFrac,
      onVisualFracChange,
      onClickIndex,
      onScrubStart,
    };

    return (
      <div className="relative flex-none overflow-visible @5xl/workspace:min-h-0 @5xl/workspace:flex-1 @5xl/workspace:overflow-y-auto" ref={scrollRef}>
        <div ref={cursorLineRef} className="pointer-events-none absolute top-0 bottom-0 z-10 border-l border-dotted border-app-text/50" style={{ display: "none" }} aria-hidden="true" />
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
