import { useEffect, useRef, useState } from "react";
import { GRIP_MAX_SAMPLES } from "./GripSparkline";

// Consistent color coding across all per-wheel charts: FL=cyan, FR=purple, RL=amber, RR=emerald
export const TIRE_COLORS = ["#22d3ee", "#a855f7", "#fbbf24", "#34d399"];
export const TIRE_LABELS = ["FL", "FR", "RL", "RR"];

/**
 * FourLineChart — Overlays all 4 tire channels on one canvas (e.g., temp, wear, grip).
 * X-axis is a fixed-width sliding window (GRIP_MAX_SAMPLES); new data enters from the right.
 * Re-renders on a 200ms interval timer rather than per-packet to avoid excessive repaints.
 */
export function FourLineChart({ data, label, maxY, unit, height = 50 }: {
  data: { fl: number[]; fr: number[]; rl: number[]; rr: number[] };
  label: string;
  maxY?: number;
  unit?: string;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);

  // Re-render periodically
  useEffect(() => {
    const id = setInterval(() => setRenderTick((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const arrays = [data.fl, data.fr, data.rl, data.rr];
    const allVals = arrays.flatMap((a) => a);
    if (allVals.length === 0) return;

    const computedMax = maxY ?? (Math.max(...allVals) * 1.1 || 1);
    const computedMin = maxY != null ? 0 : Math.min(...allVals) * 0.9;
    const yRange = computedMax - computedMin || 1;
    const maxLen = GRIP_MAX_SAMPLES;

    // Y axis: min/max labels
    ctx.font = "7px monospace";
    ctx.fillStyle = "#475569";
    ctx.textAlign = "left";
    ctx.fillText(`${computedMax.toFixed(0)}${unit ?? ""}`, 1, 8);
    ctx.fillText(`${computedMin.toFixed(0)}${unit ?? ""}`, 1, height - 2);

    // Draw each tire line
    for (let t = 0; t < 4; t++) {
      const arr = arrays[t];
      if (arr.length < 2) continue;
      const startIdx = maxLen - arr.length;
      const step = width / (maxLen - 1);

      ctx.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const x = (startIdx + i) * step;
        const y = height - ((arr[i] - computedMin) / yRange) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = TIRE_COLORS[t];
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;

    }
  }, [renderTick, data, maxY, height]);

  void renderTick;
  const arrays = [data.fl, data.fr, data.rl, data.rr];
  const currentVals = arrays.map((a) => a.length > 0 ? a[a.length - 1] : 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] text-app-text-muted font-semibold uppercase">{label}</span>
        <div className="flex gap-2">
          {TIRE_LABELS.map((l, i) => (
            <span key={l} className="text-[8px] font-mono" style={{ color: TIRE_COLORS[i] }}>{l}</span>
          ))}
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-app-surface/40" />
        </div>
        <div className="flex flex-col justify-between w-10 shrink-0" style={{ height }}>
          {TIRE_LABELS.map((l, i) => (
            <span key={l} className="text-[10px] font-mono font-bold tabular-nums text-right" style={{ color: TIRE_COLORS[i] }}>
              {currentVals[i].toFixed(1)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** SingleLineChart — Same sliding-window canvas approach as FourLineChart but for a single metric. */
export function SingleLineChart({ data, label, color, maxY, height = 50 }: {
  data: number[];
  label: string;
  color: string;
  maxY?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setRenderTick((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || data.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const computedMax = maxY ?? (Math.max(...data) * 1.1 || 1);
    const yRange = computedMax || 1;
    const maxLen = GRIP_MAX_SAMPLES;
    const startIdx = maxLen - data.length;
    const step = width / (maxLen - 1);

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (startIdx + i) * step;
      const y = height - (data[i] / yRange) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;

  }, [renderTick, data, maxY, height, color]);

  // Force read current value on each tick
  void renderTick;
  const currentVal = data.length > 0 ? data[data.length - 1] : 0;

  return (
    <div>
      <span className="text-[9px] text-app-text-muted font-semibold uppercase">{label}</span>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-app-surface/40" />
        </div>
        <div className="flex items-center w-12 shrink-0">
          <span className="text-[10px] font-mono font-bold tabular-nums text-right w-full" style={{ color }}>{currentVal.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}

/** DualLineChart — Two overlaid lines sharing one Y-axis (e.g., throttle vs brake trace). */
export function DualLineChart({ data1, data2, label1, label2, color1, color2, label, maxY, height = 50 }: {
  data1: number[];
  data2: number[];
  label1: string;
  label2: string;
  color1: string;
  color2: string;
  label: string;
  maxY?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setRenderTick((v) => v + 1), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || data1.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const computedMax = maxY ?? (Math.max(...data1, ...data2) * 1.1 || 1);
    const yRange = computedMax || 1;
    const maxLen = GRIP_MAX_SAMPLES;

    const drawLine = (data: number[], color: string) => {
      const startIdx = maxLen - data.length;
      const step = width / (maxLen - 1);
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = (startIdx + i) * step;
        const y = height - (data[i] / yRange) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.8;
      ctx.stroke();
      ctx.globalAlpha = 1;

    };

    drawLine(data1, color1);
    drawLine(data2, color2);
  }, [renderTick, data1, data2, maxY, height, color1, color2]);

  const val1 = data1.length > 0 ? data1[data1.length - 1] : 0;
  const val2 = data2.length > 0 ? data2[data2.length - 1] : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] text-app-text-muted font-semibold uppercase">{label}</span>
        <div className="flex gap-2">
          <span className="text-[8px] font-mono" style={{ color: color1 }}>{label1}</span>
          <span className="text-[8px] font-mono" style={{ color: color2 }}>{label2}</span>
        </div>
      </div>
      <div className="flex gap-1.5">
        <div className="flex-1" ref={containerRef}>
          <canvas ref={canvasRef} style={{ width: "100%", height }} className="rounded bg-app-surface/40" />
        </div>
        <div className="flex flex-col justify-between w-10 shrink-0" style={{ height }}>
          <span className="text-[10px] font-mono font-bold tabular-nums text-right" style={{ color: color1 }}>{val1.toFixed(0)}</span>
          <span className="text-[10px] font-mono font-bold tabular-nums text-right" style={{ color: color2 }}>{val2.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}
