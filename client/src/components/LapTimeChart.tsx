import { useState, useEffect, useRef, useMemo } from "react";
import type { TelemetryPacket, LapMeta } from "@shared/types";
import { formatLapTime } from "./LiveTelemetry";
/**
 * LapTimeChart — Canvas-drawn lap time trend with pace reference lines.
 * "Optimum" = median of top 5 laps (robust to single-flier best laps).
 * "Avg" = mean of last 4 laps (recent rolling pace).
 * Dots are colored: purple=best, green=on pace (<=optimum), orange=off pace.
 *
 * Pure-ish: the caller supplies `allLaps` (historical) and `packet` (for live
 * lap accumulation on lap-number boundaries).
 */
export function LapTimeChart({
  packet,
  allLaps = [],
  height,
  yTicks = 5,
  maxLaps = 10,
}: {
  packet: TelemetryPacket | null;
  allLaps?: LapMeta[];
  /** Optional fixed height. If omitted the chart fills its parent via flex. */
  height?: number;
  /** Number of y-axis intervals (ticks = yTicks + 1). Default 5. */
  yTicks?: number;
  /** Maximum number of laps shown. X-axis step is anchored to this so existing
   *  dots don't shift as new laps arrive. Default 10. */
  maxLaps?: number;
}) {
  const [liveLaps, setLiveLaps] = useState<{ lap: number; time: number }[]>([]);
  const [hiddenSessionIds, setHiddenSessionIds] = useState<Set<number>>(new Set());
  const lastLapRef = useRef<number>(0);

  const recordedLaps = useMemo(() => {
    if (!packet?.TrackOrdinal) return [];
    const trackLaps = allLaps.filter((l) => l.lapTime > 0 && l.trackOrdinal === packet.TrackOrdinal && !hiddenSessionIds.has(l.sessionId));
    // Only show laps from the most recent session (don't mix qualifying into race)
    const latestSessionId = trackLaps.length > 0 ? Math.max(...trackLaps.map((l) => l.sessionId)) : null;
    return trackLaps
      .filter((l) => l.sessionId === latestSessionId)
      .map((l) => ({ lap: l.lapNumber, time: l.lapTime }))
      .slice(-maxLaps);
  }, [allLaps, packet, hiddenSessionIds, maxLaps]);

  // Merge recorded + live laps
  const laps = useMemo(() => {
    const merged = [...recordedLaps];
    for (const live of liveLaps) {
      if (!merged.some((l) => l.lap === live.lap && Math.abs(l.time - live.time) < 0.01)) {
        merged.push(live);
      }
    }
    return merged.slice(-maxLaps);
  }, [recordedLaps, liveLaps, maxLaps]);

  // Accumulate live laps
  useEffect(() => {
    if (!packet) return;
    if (packet.LapNumber > lastLapRef.current && packet.LastLap > 0 && lastLapRef.current > 0) {
      setLiveLaps((prev) => {
        if (prev.some((l) => l.lap === lastLapRef.current)) return prev;
        return [...prev, { lap: lastLapRef.current, time: packet.LastLap }];
      });
    }
    lastLapRef.current = packet.LapNumber;
  }, [packet?.LapNumber]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizeTick, setResizeTick] = useState(0);

  // Re-draw on canvas resize without owning size in state — the canvas'
  // CSS dimensions (calc(100% - 16px)) drive layout; we just measure
  // clientWidth/clientHeight at draw time.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  const handleClearAll = () => {
    setLiveLaps([]);
    // Hide all current sessions so recorded laps disappear from chart
    const sessionIds = new Set(allLaps.map((l) => l.sessionId));
    setHiddenSessionIds(sessionIds);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || laps.length < 1) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (width <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    // Only resize the bitmap when logical size actually changed — avoids
    // clearing + re-scaling the context on every re-render.
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
    const optimum = top5.length % 2 === 0
      ? (top5[top5.length / 2 - 1] + top5[top5.length / 2]) / 2
      : top5[Math.floor(top5.length / 2)];
    const optimumY = yOf(optimum);

    const recent4 = times.slice(-4);
    const avgPace = recent4.reduce((a, b) => a + b, 0) / recent4.length;
    const avgY = yOf(avgPace);

    const chartW = width - leftPad - rightPad;

    ctx.font = "13px monospace";
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "right";
    const tickCount = yTicks;
    for (let i = 0; i <= tickCount; i++) {
      const val = minY + (yRange * i) / tickCount;
      const y = topPad + plotH - (i / tickCount) * plotH;
      ctx.fillText(formatLapTime(val), leftPad - 6, y + 5);
      ctx.strokeStyle = "rgba(100,116,139,0.08)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(width - rightPad, y);
      ctx.stroke();
    }

    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#a855f7";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, optimumY);
    ctx.lineTo(width - rightPad, optimumY);
    ctx.stroke();

    ctx.strokeStyle = "#fbbf24";
    ctx.beginPath();
    ctx.moveTo(leftPad, avgY);
    ctx.lineTo(width - rightPad, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "12px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "#a855f7";
    ctx.fillText(`optimum`, width - rightPad - 2, optimumY - 5);
    ctx.fillStyle = "#fbbf24";
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
    ctx.strokeStyle = "rgba(34,211,238,0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const labelEvery = Math.max(1, Math.ceil((laps.length * 32) / Math.max(1, chartW)));
    for (let i = 0; i < laps.length; i++) {
      const x = leftPad + i * step;
      const y = yOf(laps[i].time);
      const isBest = laps[i].time === best;
      ctx.beginPath();
      ctx.arc(x, y, isBest ? dotR + 1 : dotR, 0, Math.PI * 2);
      ctx.fillStyle = isBest ? "#a855f7" : laps[i].time <= optimum ? "#34d399" : "#fb923c";
      ctx.fill();

      if (i % labelEvery === 0 || i === laps.length - 1) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "12px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`${laps[i].lap}`, x, topPad + plotH + 14);
      }
    }
  }, [laps, yTicks, maxLaps, resizeTick]);

  return (
    <div className="h-full flex flex-col border-b border-app-border">
      <div className="shrink-0 p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Lap Times</h2>
        <button
          onClick={handleClearAll}
          className="text-[10px] text-red-400 hover:text-red-300 font-mono"
        >
          Clear All
        </button>
      </div>
      <div className="flex-1 min-h-0 relative p-2" ref={containerRef} style={height ? { height: height + 16 } : undefined}>
        {laps.length === 0 && (
          <div className="absolute inset-2 flex items-center justify-center rounded bg-app-surface/40 text-app-text-dim text-sm">
            Complete a lap to see lap times
          </div>
        )}
        <canvas
          ref={canvasRef}
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
            <div className="w-3 h-0.5 bg-cyan-400 rounded" />
            <span className="text-xs text-app-text-muted">Lap time</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 bg-purple-500 rounded border-dashed" style={{ borderTop: "1px dashed #a855f7", height: 0 }} />
            <span className="text-xs text-app-text-muted">Optimum (top 5 median)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3" style={{ borderTop: "1px dashed #fbbf24", height: 0 }} />
            <span className="text-xs text-app-text-muted">Avg (last 4)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-purple-500" />
            <span className="text-xs text-app-text-muted">Best</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-xs text-app-text-muted">On pace</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-orange-400" />
            <span className="text-xs text-app-text-muted">Off pace</span>
          </div>
        </div>
      </div>
    </div>
  );
}
