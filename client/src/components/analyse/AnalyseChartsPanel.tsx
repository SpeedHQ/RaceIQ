import { memo, useMemo, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import type { DisplayPacket } from "../../lib/convert-packet";
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
  displayTelemetry: DisplayPacket[];
  cursorIdx: number;
  totalPackets: number;
  visualTimeFrac: number | null;
  onVisualFracChange: (frac: number | null) => void;
  onClickIndex: (idx: number) => void;
  onScrubStart: () => void;
  speedLabel: string;
  tempLabel: string;
}

function buildChartData(displayTelemetry: DisplayPacket[]): ChartData | null {
  if (displayTelemetry.length === 0) return null;
  const speed: number[] = [];
  const throttle: number[] = [];
  const brake: number[] = [];
  const rpm: number[] = [];
  const steering: number[] = [];
  const drs: number[] = [];
  const ersStore: number[] = [];
  const ersDeployed: number[] = [];

  const isF1 = displayTelemetry[0]?.gameId === "f1-2025";
  const tireTempFL: number[] = [], tireTempFR: number[] = [], tireTempRL: number[] = [], tireTempRR: number[] = [];
  const brakeTempFL: number[] = [], brakeTempFR: number[] = [], brakeTempRL: number[] = [], brakeTempRR: number[] = [];
  let hasBrakeTemp = false;

  const startTime = displayTelemetry[0].CurrentLap;
  // Use max CurrentLap as end time — last packet may have reset to next lap
  let maxTime = startTime;
  for (const p of displayTelemetry) {
    if (p.CurrentLap > maxTime) maxTime = p.CurrentLap;
  }
  const lapDuration = maxTime - startTime || 1;
  const timeFracs: number[] = [];

  let prevFrac = 0;
  for (const p of displayTelemetry) {
    const frac = Math.max(prevFrac, (p.CurrentLap - startTime) / lapDuration);
    timeFracs.push(frac);
    prevFrac = frac;
    speed.push(p.DisplaySpeed);
    throttle.push((p.Accel / 255) * 100);
    brake.push((p.Brake / 255) * 100);
    rpm.push(p.CurrentEngineRpm);
    steering.push(p.Steer);
    if (isF1) {
      drs.push(p.DrsActive ?? 0);
      ersStore.push(((p.ErsStoreEnergy ?? 0) / 4_000_000) * 100);
      ersDeployed.push(((p.ErsDeployed ?? 0) / 4_000_000) * 100);
    }
    tireTempFL.push(p.DisplayTireTempFL ?? p.TireTempFL);
    tireTempFR.push(p.DisplayTireTempFR ?? p.TireTempFR);
    tireTempRL.push(p.DisplayTireTempRL ?? p.TireTempRL);
    tireTempRR.push(p.DisplayTireTempRR ?? p.TireTempRR);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const btfl = p.BrakeTempFrontLeft ?? (p as any).f1?.brakeTempFL ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const btfr = p.BrakeTempFrontRight ?? (p as any).f1?.brakeTempFR ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const btrl = p.BrakeTempRearLeft ?? (p as any).f1?.brakeTempRL ?? 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const btrr = p.BrakeTempRearRight ?? (p as any).f1?.brakeTempRR ?? 0;
    brakeTempFL.push(btfl); brakeTempFR.push(btfr); brakeTempRL.push(btrl); brakeTempRR.push(btrr);
    if (btfl > 0) hasBrakeTemp = true;
  }
  const times = displayTelemetry.map(p => p.CurrentLap);
  return {
    speed, throttle, brake, rpm, steering, timeFracs, times,
    tireTempFL, tireTempFR, tireTempRL, tireTempRR,
    ...(hasBrakeTemp ? { brakeTempFL, brakeTempFR, brakeTempRL, brakeTempRR } : {}),
    ...(isF1 ? { drs, ersStore, ersDeployed } : {}),
  };
}

export const AnalyseChartsPanel = memo(forwardRef<ChartsPanelHandle, ChartsPanelProps>(function AnalyseChartsPanel({
  displayTelemetry,
  cursorIdx,
  totalPackets,
  visualTimeFrac,
  onVisualFracChange,
  onClickIndex,
  onScrubStart,
  speedLabel,
  tempLabel,
}, ref) {
  const chartData = useMemo(() => buildChartData(displayTelemetry), [displayTelemetry]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cursorOverlayRef = useRef<HTMLCanvasElement>(null);

  // Keep a ref so the imperative handle always returns current data
  const chartDataRef = useRef(chartData);
  chartDataRef.current = chartData;

  // Draw a single shared cursor line across all charts
  const drawSharedCursor = useCallback((idx: number) => {
    const overlay = cursorOverlayRef.current;
    const scroll = scrollRef.current;
    if (!overlay || !scroll) return;

    const dpr = window.devicePixelRatio || 1;
    const w = scroll.clientWidth;
    const h = scroll.scrollHeight;
    overlay.width = w * dpr;
    overlay.height = h * dpr;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const timeFracs = chartDataRef.current?.timeFracs;
    const totalPackets = displayTelemetry.length;
    if (totalPackets < 2) return;

    const xFrac = timeFracs && idx < timeFracs.length ? timeFracs[idx] : (idx / (totalPackets - 1));

    // All charts share the same padding constants
    const leftPad = 40;
    const rightPad = 8;
    const chartW = w - leftPad - rightPad;
    const cx = leftPad + xFrac * chartW;

    // Draw a single vertical line spanning the full scroll height
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [displayTelemetry.length]);

  useImperativeHandle(ref, () => ({
    get timeFracs() { return chartDataRef.current?.timeFracs ?? null; },
    get times() { return chartDataRef.current?.times ?? null; },
    updateCursor: drawSharedCursor,
  }), [drawSharedCursor]);

  if (!chartData) return null;

  const common = {
    cursorIdx,
    totalPackets,
    timeFracs: chartData.timeFracs,
    times: chartData.times,
    visualTimeFrac,
    onVisualFracChange,
    onClickIndex,
    onScrubStart,
  };


  return (
    <div className="flex-1 min-h-0 overflow-y-auto relative" ref={scrollRef}>
      <canvas
        ref={cursorOverlayRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ zIndex: 10 }}
      />
      <div className="p-3 space-y-2">
        <TelemetryChart

          series={[{ data: chartData.speed, color: "#22d3ee", label: `Speed (${speedLabel})` }]}
          {...common}
          height={100}
        />
        <TelemetryChart

          series={[
            { data: chartData.throttle, color: "#34d399", label: "Throttle %" },
            { data: chartData.brake, color: "#ef4444", label: "Brake %" },
          ]}
          {...common}
          height={100}
        />
        <TelemetryChart

          series={[{ data: chartData.rpm, color: "#a855f7", label: "RPM" }]}
          {...common}
          height={100}
        />
        <TelemetryChart

          series={[{ data: chartData.steering, color: "#fbbf24", label: "Steering" }]}
          {...common}
          height={80}
        />
        {chartData.drs && (
          <TelemetryChart
            series={[{ data: chartData.drs, color: "#22c55e", label: "DRS" }]}
            {...common}
            height={40}
          />
        )}
        {chartData.ersStore && chartData.ersDeployed && (
          <TelemetryChart
            series={[
              { data: chartData.ersStore, color: "#3b82f6", label: "ERS Store %" },
              { data: chartData.ersDeployed, color: "#f59e0b", label: "ERS Deployed %" },
            ]}
            {...common}
            height={80}
          />
        )}
        <TelemetryChart
          series={[
            { data: chartData.tireTempFL, color: "#ef4444", label: `Tire FL ${tempLabel}` },
            { data: chartData.tireTempFR, color: "#f59e0b", label: `Tire FR ${tempLabel}` },
            { data: chartData.tireTempRL, color: "#3b82f6", label: `Tire RL ${tempLabel}` },
            { data: chartData.tireTempRR, color: "#22d3ee", label: `Tire RR ${tempLabel}` },
          ]}
          {...common}
          height={80}
        />
        {chartData.brakeTempFL && chartData.brakeTempFR && chartData.brakeTempRL && chartData.brakeTempRR && (
          <TelemetryChart
            series={[
              { data: chartData.brakeTempFL, color: "#ef4444", label: "Brake FL °C" },
              { data: chartData.brakeTempFR, color: "#f59e0b", label: "Brake FR °C" },
              { data: chartData.brakeTempRL, color: "#3b82f6", label: "Brake RL °C" },
              { data: chartData.brakeTempRR, color: "#22d3ee", label: "Brake RR °C" },
            ]}
            {...common}
            height={80}
          />
        )}
      </div>
    </div>
  );
}));
