import { useState, useEffect, useRef } from "react";
import type { TelemetryPacket } from "@shared/types";
import { formatLapTime } from "./LiveTelemetry";

/**
 * LapTimeChart — Canvas-drawn lap time trend with pace reference lines.
 * "Optimum" = median of top 5 laps (robust to single-flier best laps).
 * "Avg" = mean of last 4 laps (recent rolling pace).
 * Dots are colored: purple=best, green=on pace (<=optimum), orange=off pace.
 * Seeds from /api/laps on mount, then appends live laps on LapNumber boundary.
 */
export function LapTimeChart({ packet }: { packet: TelemetryPacket | null }) {
  const [laps, setLaps] = useState<{ lap: number; time: number }[]>([]);
  const lastLapRef = useRef<number>(0);
  const trackOrdRef = useRef<number | null>(null);

  // Fetch laps for the current track, re-fetch when track changes
  useEffect(() => {
    if (!packet?.TrackOrdinal) return;
    if (packet.TrackOrdinal === trackOrdRef.current) return;
    trackOrdRef.current = packet.TrackOrdinal;
    lastLapRef.current = 0;

    fetch("/api/laps")
      .then((r) => r.json())
      .then((data: { id: number; lapNumber: number; lapTime: number; trackOrdinal?: number }[]) => {
        if (Array.isArray(data)) {
          const recorded = data
            .filter((l) => l.lapTime > 0 && l.trackOrdinal === packet.TrackOrdinal)
            .map((l) => ({ lap: l.lapNumber, time: l.lapTime }))
            .slice(-10);
          setLaps(recorded);
        }
      })
      .catch(() => {});
  }, [packet?.TrackOrdinal]);

  // Accumulate live laps (only if same track)
  useEffect(() => {
    if (!packet) return;
    if (packet.TrackOrdinal !== trackOrdRef.current) return;
    if (packet.LapNumber > lastLapRef.current && packet.LastLap > 0 && lastLapRef.current > 0) {
      setLaps((prev) => {
        if (prev.some((l) => l.lap === lastLapRef.current)) return prev;
        const next = [...prev, { lap: lastLapRef.current, time: packet.LastLap }];
        return next.slice(-10);
      });
    }
    lastLapRef.current = packet.LapNumber;
  }, [packet?.LapNumber]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const height = 160;

  const handleClearAll = () => {
    fetch("/api/laps", { method: "DELETE" })
      .then(() => setLaps([]))
      .catch(() => {});
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || laps.length < 1) return;
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

    const leftPad = 45;
    const rightPad = 10;

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
    const optimumY = height - ((optimum - minY) / yRange) * height;

    const recent4 = times.slice(-4);
    const avgPace = recent4.reduce((a, b) => a + b, 0) / recent4.length;
    const avgY = height - ((avgPace - minY) / yRange) * height;

    const chartW = width - leftPad - rightPad;

    ctx.font = "8px monospace";
    ctx.fillStyle = "#475569";
    ctx.textAlign = "right";
    const tickCount = 4;
    for (let i = 0; i <= tickCount; i++) {
      const val = minY + (yRange * i) / tickCount;
      const y = height - (i / tickCount) * height;
      ctx.fillText(formatLapTime(val), leftPad - 4, y + 3);
      ctx.strokeStyle = "rgba(100,116,139,0.08)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(width - rightPad, y);
      ctx.stroke();
    }

    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(168,85,247,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, optimumY);
    ctx.lineTo(width - rightPad, optimumY);
    ctx.stroke();

    ctx.strokeStyle = "rgba(251,191,36,0.4)";
    ctx.beginPath();
    ctx.moveTo(leftPad, avgY);
    ctx.lineTo(width - rightPad, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(168,85,247,0.7)";
    ctx.fillText(`optimum`, width - rightPad - 2, optimumY - 3);
    ctx.fillStyle = "rgba(251,191,36,0.6)";
    ctx.fillText(`avg`, width - rightPad - 2, avgY - 3);

    const step = laps.length > 1 ? chartW / (laps.length - 1) : chartW / 2;
    ctx.beginPath();
    for (let i = 0; i < laps.length; i++) {
      const x = leftPad + i * step;
      const y = height - ((laps[i].time - minY) / yRange) * height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(34,211,238,0.8)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    for (let i = 0; i < laps.length; i++) {
      const x = leftPad + i * step;
      const y = height - ((laps[i].time - minY) / yRange) * height;
      const isBest = laps[i].time === best;
      ctx.beginPath();
      ctx.arc(x, y, isBest ? 3.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isBest ? "#a855f7" : laps[i].time <= optimum ? "#34d399" : "#fb923c";
      ctx.fill();

      ctx.fillStyle = "#475569";
      ctx.font = "7px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${laps[i].lap}`, x, height - 2);
    }
  }, [laps]);

  if (laps.length === 0) return null;

  return (
    <div className="border-b border-app-border">
      <div className="p-2 border-b border-app-border flex items-center justify-between">
        <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Lap Times</h2>
        <button
          onClick={handleClearAll}
          className="text-[10px] text-red-400 hover:text-red-300 font-mono"
        >
          Clear All
        </button>
      </div>
      <div className="p-3" ref={containerRef}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height }}
          className="rounded bg-app-surface/40"
        />
        <div className="flex gap-3 mt-1.5 flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 bg-cyan-400 rounded" />
            <span className="text-[9px] text-app-text-muted">Lap time</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-0.5 bg-purple-500 rounded border-dashed" style={{ borderTop: "1px dashed #a855f7", height: 0 }} />
            <span className="text-[9px] text-app-text-muted">Optimum (top 5 median)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3" style={{ borderTop: "1px dashed #fbbf24", height: 0 }} />
            <span className="text-[9px] text-app-text-muted">Avg (last 4)</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-purple-500" />
            <span className="text-[9px] text-app-text-muted">Best</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-[9px] text-app-text-muted">On pace</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-orange-400" />
            <span className="text-[9px] text-app-text-muted">Off pace</span>
          </div>
        </div>
      </div>
    </div>
  );
}
