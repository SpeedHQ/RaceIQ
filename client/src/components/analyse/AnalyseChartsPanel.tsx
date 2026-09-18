import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import type { GameId } from "../../../../shared/games/ids";
import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
import { semanticNumber, semanticWheelNumbers, type SemanticAnalysisFrame } from "./track-map/types";
import { m } from "../../paraglide/messages";
import { TelemetryChart } from "./AnalyseTelemetryChart";
import { useUnits } from "../../hooks/useUnits";

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
  tireCoreTempFL?: number[];
  tireCoreTempFR?: number[];
  tireCoreTempRL?: number[];
  tireCoreTempRR?: number[];
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
  gameId: GameId;
  semanticFrames: SemanticAnalysisFrame[];
  totalPackets: number;
  visualTimeFrac: number | null;
  onVisualFracChange: (frac: number | null) => void;
  onClickIndex: (idx: number) => void;
  onScrubStart: () => void;
  speedLabel: string;
}


const wheel = (frame: SemanticAnalysisFrame, id: Parameters<typeof semanticNumber>[1], index: number): number | null => {
  const value = frame.values[id];
  return Array.isArray(value) ? semanticWheelNumbers(frame, id)[index] : semanticNumber(frame, id);
};

export function buildChartData(
  semanticFrames: SemanticAnalysisFrame[],
  tireTemperatureSemanticId: Parameters<typeof semanticNumber>[1] = "tire.temperature.surface.representative",
  temperatureConverter: (celsius: number) => number = (celsius) => celsius,
): ChartData | null {
  if (semanticFrames.length === 0) return null;
  const speed: number[] = [], throttle: number[] = [], brake: number[] = [], rpm: number[] = [], steering: number[] = [];
  const tireTempFL: number[] = [], tireTempFR: number[] = [], tireTempRL: number[] = [], tireTempRR: number[] = [];
  const tireCoreTempFL: number[] = [], tireCoreTempFR: number[] = [], tireCoreTempRL: number[] = [], tireCoreTempRR: number[] = [];
  const times = semanticFrames.map((frame) => semanticNumber(frame, "timing.current-lap") ?? NaN);
  const firstTime = times[0];
  const maxTime = Math.max(...times.filter(Number.isFinite), firstTime);
  const lapDuration = maxTime - firstTime || 1;
  let previousTimeFrac = 0;
  const timeFracs = times.map((time) => {
    if (!Number.isFinite(time)) return NaN;
    previousTimeFrac = Math.max(previousTimeFrac, Math.max(0, (time - firstTime) / lapDuration));
    return previousTimeFrac;
  });
  let hasBrakeTemp = false;
  let hasCoreTemp = false;
  let hasTireTemp = false;
  const brakeTempFL: number[] = [], brakeTempFR: number[] = [], brakeTempRL: number[] = [], brakeTempRR: number[] = [];
  for (const frame of semanticFrames) {
    speed.push(semanticNumber(frame, "motion.speed") ?? NaN);
    throttle.push(semanticNumber(frame, "inputs.accel") ?? NaN);
    brake.push(semanticNumber(frame, "inputs.brake") ?? NaN);
    rpm.push(semanticNumber(frame, "engine.current-engine-rpm") ?? NaN);
    steering.push(semanticNumber(frame, "inputs.steer") ?? NaN);
    const temperatures = [0, 1, 2, 3].map((index) => {
      const value = wheel(frame, tireTemperatureSemanticId, index);
      return value == null ? null : temperatureConverter(value);
    });
    tireTempFL.push(temperatures[0] ?? NaN);
    tireTempFR.push(temperatures[1] ?? NaN);
    tireTempRL.push(temperatures[2] ?? NaN);
    tireTempRR.push(temperatures[3] ?? NaN);
    if (temperatures.some((value) => value != null)) hasTireTemp = true;
    const core = [0, 1, 2, 3].map((index) => {
      const value = wheel(frame, "tire.temperature.core", index);
      return value == null ? null : temperatureConverter(value);
    });
    tireCoreTempFL.push(core[0] ?? NaN);
    tireCoreTempFR.push(core[1] ?? NaN);
    tireCoreTempRL.push(core[2] ?? NaN);
    tireCoreTempRR.push(core[3] ?? NaN);
    if (core.some((value) => value != null)) hasCoreTemp = true;
    const brakes = [0, 1, 2, 3].map((index) => {
      const value = wheel(frame, "brakes.brake-temp", index);
      return value == null ? null : temperatureConverter(value);
    });
    brakeTempFL.push(brakes[0] ?? NaN);
    brakeTempFR.push(brakes[1] ?? NaN);
    brakeTempRL.push(brakes[2] ?? NaN);
    brakeTempRR.push(brakes[3] ?? NaN);
    if (brakes.some((value) => value != null)) hasBrakeTemp = true;
  }
  return {
    speed, throttle, brake, rpm, steering, timeFracs, times, tireTempFL, tireTempFR, tireTempRL, tireTempRR,
    ...(hasTireTemp && hasCoreTemp && tireTemperatureSemanticId === "tire.temperature.surface.representative" ? { tireCoreTempFL, tireCoreTempFR, tireCoreTempRL, tireCoreTempRR } : {}),
    ...(hasBrakeTemp ? { brakeTempFL, brakeTempFR, brakeTempRL, brakeTempRR } : {}),
  };
}

export const AnalyseChartsPanel = memo(
  forwardRef<ChartsPanelHandle, ChartsPanelProps>(function AnalyseChartsPanel(
    { semanticFrames, totalPackets, visualTimeFrac, onVisualFracChange, onClickIndex, onScrubStart, speedLabel, gameId },
    ref,
  ) {
    const units = useUnits(gameId);
    const temperatureMetric = resolveAnalysisTelemetry(getGame(gameId)).tireTemperature;
    const tireTemperatureSemanticId = temperatureMetric.source !== "unavailable" && temperatureMetric.binding?.kind === "value"
      ? temperatureMetric.binding.semanticId
      : "tire.temperature.surface.representative";
    const chartData = useMemo(
      () => buildChartData(semanticFrames, tireTemperatureSemanticId, units.temp),
      [semanticFrames, tireTemperatureSemanticId, units.temp],
    );
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
        const totalPackets = semanticFrames.length;
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
      [semanticFrames.length],
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
          <TelemetryChart series={[{ data: chartData.steering, color: "var(--telemetry-steering)", label: m.analyse_chart_steering() }]} {...common} height={80} />
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
              { data: chartData.tireTempFL, color: WHEEL_COLOR_VARS[0], label: `${chartData.tireCoreTempFL ? "Surface" : "Tire Temp"} FL ${units.tempLabel}` },
              { data: chartData.tireTempFR, color: WHEEL_COLOR_VARS[1], label: `${chartData.tireCoreTempFR ? "Surface" : "Tire Temp"} FR ${units.tempLabel}` },
              { data: chartData.tireTempRL, color: WHEEL_COLOR_VARS[2], label: `${chartData.tireCoreTempRL ? "Surface" : "Tire Temp"} RL ${units.tempLabel}` },
              { data: chartData.tireTempRR, color: WHEEL_COLOR_VARS[3], label: `${chartData.tireCoreTempRR ? "Surface" : "Tire Temp"} RR ${units.tempLabel}` },
            ]}
            {...common}
            height={80}
          />
          {chartData.tireCoreTempFL && chartData.tireCoreTempFR && chartData.tireCoreTempRL && chartData.tireCoreTempRR && (
            <TelemetryChart
              series={[
                { data: chartData.tireCoreTempFL, color: WHEEL_COLOR_VARS[0], label: `Core FL ${units.tempLabel}` },
                { data: chartData.tireCoreTempFR, color: WHEEL_COLOR_VARS[1], label: `Core FR ${units.tempLabel}` },
                { data: chartData.tireCoreTempRL, color: WHEEL_COLOR_VARS[2], label: `Core RL ${units.tempLabel}` },
                { data: chartData.tireCoreTempRR, color: WHEEL_COLOR_VARS[3], label: `Core RR ${units.tempLabel}` },
              ]}
              {...common}
              height={80}
            />
          )}
          {chartData.brakeTempFL && chartData.brakeTempFR && chartData.brakeTempRL && chartData.brakeTempRR && (
            <TelemetryChart
              series={[
                { data: chartData.brakeTempFL, color: WHEEL_COLOR_VARS[0], label: `Brake FL ${units.tempLabel}` },
                { data: chartData.brakeTempFR, color: WHEEL_COLOR_VARS[1], label: `Brake FR ${units.tempLabel}` },
                { data: chartData.brakeTempRL, color: WHEEL_COLOR_VARS[2], label: `Brake RL ${units.tempLabel}` },
                { data: chartData.brakeTempRR, color: WHEEL_COLOR_VARS[3], label: `Brake RR ${units.tempLabel}` },
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
