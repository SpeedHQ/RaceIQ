import { useEffect, useMemo, useRef, useState } from "react";
import { lapPaceColor } from "@/lib/colors";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import type { LapMeta } from "../../../shared/sessions/types";
import { m } from "../paraglide/messages";
import { formatLapTime } from "./LiveTelemetry";

/**
 * LapTimeChart — Canvas-drawn lap time trend with pace reference lines.
 * "Optimum" = median of top 5 laps (robust to single-flier best laps).
 * "Avg" = mean of last 4 laps (recent rolling pace).
 * Dot colors come from the theme's best/on-target/off-target lap roles.
 *
 * Data source: sessionLaps from Zustand (server-pushed via WS).
 */
export function LapTimeChart({
  sessionLaps,
  height,
  yTicks = 3,
  maxLaps = 10,
}: {
  sessionLaps: LapMeta[];
  /** Optional fixed height. If omitted the chart fills its parent via flex. */
  height?: number;
  /** Number of y-axis intervals (ticks = yTicks + 1). Default 5. */
  yTicks?: number;
  /** Maximum number of laps shown. X-axis step is anchored to this so existing
   *  dots don't shift as new laps arrive. Default 10. */
  maxLaps?: number;
}) {
  const laps = useMemo(() => {
    return [...sessionLaps]
      .filter((l) => l.lapTime > 0)
      .sort((a, b) => a.id - b.id)
      .slice(-maxLaps)
      .map((l) => ({ lap: l.lapNumber, time: l.lapTime }));
  }, [sessionLaps, maxLaps]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeTick, setResizeTick] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || laps.length < 1) return;
    canvas.dataset.visualReady = "pending";
    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;

    const width = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (width <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW) canvas.width = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);

    const leftPad = 78;
    const rightPad = 10;
    const topPad = 12;
    const bottomPad = 20;
    const plotH = Math.max(1, h - topPad - bottomPad);
    const yOf = (v: number) => topPad + plotH - ((v - minY) / yRange) * plotH;

    const times = laps.map((l) => l.time);
    const best = Math.min(...times);
    const worst = Math.max(...times);
    const pad = (worst - best) * 0.15 || 1;
    const minY = best - pad;
    const maxY = worst + pad;
    const yRange = maxY - minY;

    const sorted = [...times].sort((a, b) => a - b);
    const top5 = sorted.slice(0, Math.min(5, sorted.length));
    const optimum = top5.length % 2 === 0 ? (top5[top5.length / 2 - 1] + top5[top5.length / 2]) / 2 : top5[Math.floor(top5.length / 2)];
    const optimumY = yOf(optimum);

    const recent4 = times.slice(-4);
    const avgPace = recent4.reduce((a, b) => a + b, 0) / recent4.length;
    const avgY = yOf(avgPace);

    const chartW = width - leftPad - rightPad;

    ctx.font = "var(--text-app-detail) var(--font-mono)";
    ctx.fillStyle = "var(--app-text-muted)";
    ctx.textAlign = "right";
    const tickCount = yTicks;
    for (let i = 0; i <= tickCount; i++) {
      const val = minY + (yRange * i) / tickCount;
      const y = topPad + plotH - (i / tickCount) * plotH;
      ctx.fillText(formatLapTime(val), leftPad - 6, y + 5);
      ctx.strokeStyle = "color-mix(in srgb, var(--app-text-dim) 8%, transparent)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(width - rightPad, y);
      ctx.stroke();
    }

    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "var(--telemetry-rpm)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, optimumY);
    ctx.lineTo(width - rightPad, optimumY);
    ctx.stroke();

    ctx.strokeStyle = "var(--lap-pace-average)";
    ctx.beginPath();
    ctx.moveTo(leftPad, avgY);
    ctx.lineTo(width - rightPad, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "var(--text-app-label) var(--font-mono)";
    ctx.textAlign = "right";
    ctx.fillStyle = "var(--telemetry-rpm)";
    ctx.fillText(`optimum`, width - rightPad - 2, optimumY - 5);
    ctx.fillStyle = "var(--lap-pace-average)";
    ctx.fillText(`avg`, width - rightPad - 2, avgY - 5);

    const denom = Math.max(1, maxLaps - 1);
    const step = chartW / denom;
    const dotR = Math.max(2, Math.min(4.5, step * 0.35));
    ctx.beginPath();
    for (let i = 0; i < laps.length; i++) {
      const x = leftPad + i * step;
      const y = yOf(laps[i].time);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "color-mix(in srgb, var(--app-accent) 80%, transparent)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const labelEvery = Math.max(1, Math.ceil((laps.length * 32) / Math.max(1, chartW)));
    for (let i = 0; i < laps.length; i++) {
      const x = leftPad + i * step;
      const y = yOf(laps[i].time);
      const isBest = laps[i].time === best;
      ctx.beginPath();
      ctx.arc(x, y, isBest ? dotR + 1 : dotR, 0, Math.PI * 2);
      ctx.fillStyle = lapPaceColor(isBest, laps[i].time <= optimum);
      ctx.fill();

      if (i % labelEvery === 0 || i === laps.length - 1) {
        ctx.fillStyle = "var(--app-text-muted)";
        ctx.font = "var(--text-app-label) var(--font-mono)";
        ctx.textAlign = "center";
        ctx.fillText(`${laps[i].lap}`, x, topPad + plotH + 14);
      }
    }
    canvas.dataset.visualReady = "ready";
  }, [laps, yTicks, maxLaps, resizeTick]);

  return (
    <div className="h-full flex flex-col border-b border-app-border">
      <div className="shrink-0 p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.laptime_title()}</h2>
      </div>
      <div className="flex-1 min-h-0 relative p-2" ref={containerRef} style={height ? { height: height + 16 } : undefined}>
        {laps.length === 0 && <div className="absolute inset-2 flex items-center justify-center rounded bg-app-surface/40 text-app-text-dim text-sm">{m.laptime_empty_state()}</div>}
        <canvas
          ref={canvasRef}
          data-visual-ready={laps.length > 0 ? "pending" : "ready"}
          style={{
            position: "absolute",
            inset: 8,
            width: "calc(100% - 16px)",
            height: "calc(100% - 16px)",
            display: laps.length > 0 ? "block" : "none",
          }}
          className="rounded bg-app-surface/40"
        />
      </div>
      <div className="shrink-0 p-2 border-t border-app-border/50">
        <div className="flex gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded" style={{ backgroundColor: "var(--app-accent)" }} />
            <span className="text-xs text-app-text-muted">{m.label_lap_time()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 rounded border-dashed" style={{ borderTop: "1px dashed var(--telemetry-rpm)", height: 0 }} />
            <span className="text-xs text-app-text-muted">{m.laptime_legend_optimum()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3" style={{ borderTop: "1px dashed var(--lap-pace-average)", height: 0 }} />
            <span className="text-xs text-app-text-muted">{m.laptime_legend_avg()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--lap-pace-best)" }} />
            <span className="text-xs text-app-text-muted">{m.label_best()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--lap-pace-on-target)" }} />
            <span className="text-xs text-app-text-muted">{m.laptime_legend_on_pace()}</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "var(--lap-pace-off-target)" }} />
            <span className="text-xs text-app-text-muted">{m.laptime_legend_off_pace()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
