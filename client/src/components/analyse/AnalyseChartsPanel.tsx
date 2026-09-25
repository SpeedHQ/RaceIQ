import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import type { GameId } from "../../../../shared/games/ids";
import { forwardRef, memo, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import { WHEEL_COLOR_VARS } from "@/lib/colors";
import type { SemanticAnalysisFrame } from "./track-map/types";
import { m } from "../../paraglide/messages";
import { TelemetryChart } from "./AnalyseTelemetryChart";
import { useUnits } from "../../hooks/useUnits";
import { buildChartData } from "./chart-data";


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
              { data: chartData.tireTempFL, color: WHEEL_COLOR_VARS[0], label: `${chartData.tireCoreTempFL || chartData.tireCarcassTempFL ? "Surface" : "Tire Temp"} FL ${units.tempLabel}` },
              { data: chartData.tireTempFR, color: WHEEL_COLOR_VARS[1], label: `${chartData.tireCoreTempFR || chartData.tireCarcassTempFR ? "Surface" : "Tire Temp"} FR ${units.tempLabel}` },
              { data: chartData.tireTempRL, color: WHEEL_COLOR_VARS[2], label: `${chartData.tireCoreTempRL || chartData.tireCarcassTempRL ? "Surface" : "Tire Temp"} RL ${units.tempLabel}` },
              { data: chartData.tireTempRR, color: WHEEL_COLOR_VARS[3], label: `${chartData.tireCoreTempRR || chartData.tireCarcassTempRR ? "Surface" : "Tire Temp"} RR ${units.tempLabel}` },
            ]}
            {...common}
            height={80}
          />
          {chartData.tireCoreTempFL && chartData.tireCoreTempFR && chartData.tireCoreTempRL && chartData.tireCoreTempRR && (
            <TelemetryChart
              series={[
                { data: chartData.tireCoreTempFL, color: WHEEL_COLOR_VARS[0], label: `${m.label_core()} FL ${units.tempLabel}` },
                { data: chartData.tireCoreTempFR, color: WHEEL_COLOR_VARS[1], label: `${m.label_core()} FR ${units.tempLabel}` },
                { data: chartData.tireCoreTempRL, color: WHEEL_COLOR_VARS[2], label: `${m.label_core()} RL ${units.tempLabel}` },
                { data: chartData.tireCoreTempRR, color: WHEEL_COLOR_VARS[3], label: `${m.label_core()} RR ${units.tempLabel}` },
              ]}
              {...common}
              height={80}
            />
          )}
          {chartData.tireCarcassTempFL && chartData.tireCarcassTempFR && chartData.tireCarcassTempRL && chartData.tireCarcassTempRR && (
            <TelemetryChart
              series={[
                { data: chartData.tireCarcassTempFL, color: WHEEL_COLOR_VARS[0], label: `${m.label_carcass()} FL ${units.tempLabel}` },
                { data: chartData.tireCarcassTempFR, color: WHEEL_COLOR_VARS[1], label: `${m.label_carcass()} FR ${units.tempLabel}` },
                { data: chartData.tireCarcassTempRL, color: WHEEL_COLOR_VARS[2], label: `${m.label_carcass()} RL ${units.tempLabel}` },
                { data: chartData.tireCarcassTempRR, color: WHEEL_COLOR_VARS[3], label: `${m.label_carcass()} RR ${units.tempLabel}` },
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
