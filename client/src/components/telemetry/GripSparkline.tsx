import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { severityRangeColor } from "@/lib/colors";
import { useEffect, useRef } from "react";

// Rolling window constants (shared with GripHistory)
export const GRIP_HISTORY_SECONDS = 60;
export const GRIP_SAMPLE_RATE = 10;
export const GRIP_MAX_SAMPLES = GRIP_HISTORY_SECONDS * GRIP_SAMPLE_RATE;

/**
 * GripSparkline — Canvas-drawn mini chart showing combined tire slip over time.
 * Y-axis is inverted: 0 (top) = perfect grip, 3 (bottom) = total loss.
 * Color zones use the theme's ordered severity scale.
 */
export function GripSparkline({ data, label, renderKey, width = 140, height = 40 }: { data: number[]; label: string; renderKey: number; width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;
    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const maxY = 3;

    // Zone backgrounds run from nominal grip at the top to critical loss at the bottom.
    const zoneBoundaries = [0, 0.5, 1, 2, 3];
    for (let index = 0; index < zoneBoundaries.length - 1; index++) {
      const yTop = (zoneBoundaries[index] / maxY) * height;
      const yBot = (zoneBoundaries[index + 1] / maxY) * height;
      ctx.globalAlpha = index < 2 ? 0.08 : 0.06;
      ctx.fillStyle = severityRangeColor(index, [1, 2, 3]);
      ctx.fillRect(0, yTop, width, yBot - yTop);
    }
    ctx.globalAlpha = 1;

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
    ctx.strokeStyle = "color-mix(in srgb, var(--app-text-muted) 70%, transparent)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Current value dot
    if (data.length > 0) {
      const last = data[data.length - 1];
      const lx = (startIdx + data.length - 1) * step;
      const ly = (Math.min(last, maxY) / maxY) * height;
      const gripPctVal = Math.max(0, 100 - (last / maxY) * 100);
      const dotColor = severityRangeColor(100 - gripPctVal, [17, 33, 67]);
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
    }
  }, [renderKey, width, height]);

  const raw = data.length > 0 ? data[data.length - 1] : 0;
  const gripPct = Math.max(0, Math.round(100 - (raw / 3) * 100));
  const valColor = severityRangeColor(100 - gripPct, [17, 33, 67]);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-app-micro font-semibold text-app-text-muted uppercase">{label}</span>
      <div className="flex items-center gap-1.5">
        <canvas ref={canvasRef} style={{ width, height }} className="rounded bg-app-surface/40" />
        <span className="text-xs font-mono font-bold tabular-nums" style={{ color: valColor }}>
          {gripPct}%
        </span>
      </div>
    </div>
  );
}
