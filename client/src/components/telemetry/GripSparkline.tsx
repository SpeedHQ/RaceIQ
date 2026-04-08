import { useEffect, useRef } from "react";

// Rolling window constants (shared with GripHistory)
export const GRIP_HISTORY_SECONDS = 60;
export const GRIP_SAMPLE_RATE = 10;
export const GRIP_MAX_SAMPLES = GRIP_HISTORY_SECONDS * GRIP_SAMPLE_RATE;

/**
 * GripSparkline — Canvas-drawn mini chart showing combined tire slip over time.
 * Y-axis is inverted: 0 (top) = perfect grip, 3 (bottom) = total loss.
 * Color zones provide at-a-glance severity bands (green/yellow/orange/red).
 */
export function GripSparkline({ data, label, renderKey, width = 140, height = 40 }: {
  data: number[];
  label: string;
  renderKey: number;
  width?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const maxY = 3;

    // Zone backgrounds (top = 100% grip/green, bottom = 0% loss/red)
    const zones = [
      { from: 0, to: 0.5, color: "rgba(52,211,153,0.08)" },
      { from: 0.5, to: 1.0, color: "rgba(250,204,21,0.08)" },
      { from: 1.0, to: 2.0, color: "rgba(251,146,60,0.06)" },
      { from: 2.0, to: 3.0, color: "rgba(239,68,68,0.06)" },
    ];
    for (const z of zones) {
      const yTop = (z.from / maxY) * height;
      const yBot = (z.to / maxY) * height;
      ctx.fillStyle = z.color;
      ctx.fillRect(0, yTop, width, yBot - yTop);
    }

    // Draw line (inverted: 100% grip at top, 0% at bottom)
    ctx.beginPath();
    const step = width / (GRIP_MAX_SAMPLES - 1);
    const startIdx = GRIP_MAX_SAMPLES - data.length;
    for (let i = 0; i < data.length; i++) {
      const x = (startIdx + i) * step;
      const val = Math.min(data[i], maxY);
      const y = (val / maxY) * height; // high slip = low on chart
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(148,163,184,0.7)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Current value dot
    if (data.length > 0) {
      const last = data[data.length - 1];
      const lx = (startIdx + data.length - 1) * step;
      const ly = (Math.min(last, maxY) / maxY) * height;
      const gripPctVal = Math.max(0, 100 - (last / maxY) * 100);
      const dotColor = gripPctVal > 83 ? "#34d399" : gripPctVal > 67 ? "#facc15" : gripPctVal > 33 ? "#fb923c" : "#ef4444";
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
    }
  }, [renderKey, width, height]);

  const raw = data.length > 0 ? data[data.length - 1] : 0;
  const gripPct = Math.max(0, Math.round(100 - (raw / 3) * 100));
  const valColor = gripPct > 83 ? "text-emerald-400" : gripPct > 67 ? "text-yellow-400" : gripPct > 33 ? "text-orange-400" : "text-red-400";

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] font-semibold text-app-text-muted uppercase">{label}</span>
      <div className="flex items-center gap-1.5">
        <canvas
          ref={canvasRef}
          style={{ width, height }}
          className="rounded bg-app-surface/40"
        />
        <span className={`text-xs font-mono font-bold tabular-nums ${valColor}`}>
          {gripPct}%
        </span>
      </div>
    </div>
  );
}
