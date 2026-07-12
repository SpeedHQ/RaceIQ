import { useRef, useCallback, useEffect } from "react";

export interface ChartSeries {
  data: number[];
  color: string;
  label: string;
}

export function TelemetryChart({
  series,
  cursorIdx: _cursorIdx,
  totalPackets,
  onClickIndex,
  onScrubStart,
  height = 100,
  timeFracs,
  times,
  visualTimeFrac: _visualTimeFrac,
  onVisualFracChange,
}: {
  series: ChartSeries[];
  cursorIdx: number;
  totalPackets: number;
  onClickIndex: (idx: number) => void;
  onScrubStart?: () => void;
  height?: number;
  timeFracs?: number[];
  times?: number[];
  visualTimeFrac?: number | null;
  onVisualFracChange?: (frac: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Draw static chart data — only when series/size changes, NOT on cursorIdx
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = container.clientWidth;
    const h = height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const leftPad = 40;
    const rightPad = 8;
    const topPad = 16;
    const botPad = 4;
    const chartW = w - leftPad - rightPad;
    const chartH = h - topPad - botPad;

    if (totalPackets < 2) return;

    // Compute global min/max across all series
    let gMin = Infinity,
      gMax = -Infinity;
    for (const s of series) {
      for (const v of s.data) {
        if (v < gMin) gMin = v;
        if (v > gMax) gMax = v;
      }
    }
    const pad = (gMax - gMin) * 0.05 || 1;
    gMin -= pad;
    gMax += pad;
    const range = gMax - gMin;

    // Y axis ticks (3)
    ctx.font = "9px monospace";
    ctx.fillStyle = "#475569";
    ctx.textAlign = "right";
    for (let i = 0; i <= 2; i++) {
      const val = gMin + (range * i) / 2;
      const y = topPad + chartH - (i / 2) * chartH;
      ctx.fillText(val.toFixed(0), leftPad - 4, y + 3);
      ctx.strokeStyle = "rgba(100,116,139,0.08)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(w - rightPad, y);
      ctx.stroke();
    }

    // Draw gap highlights first (behind data lines)
    if (times && timeFracs) {
      ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
      for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] > 0.1) {
          const x1 = leftPad + timeFracs[i - 1] * chartW;
          const x2 = leftPad + timeFracs[i] * chartW;
          ctx.fillRect(x1, topPad, x2 - x1, chartH);
        }
      }
    }

    // Draw each series — break line at data gaps (>0.1s between packets)
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.2;
      const n = s.data.length;
      let drawing = false;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (i > 0 && times && times[i] - times[i - 1] > 0.1) {
          drawing = false;
        }
        const xFrac = timeFracs ? timeFracs[i] : i / (n - 1);
        const x = leftPad + xFrac * chartW;
        const y = topPad + chartH - ((s.data[i] - gMin) / range) * chartH;
        if (!drawing) {
          ctx.moveTo(x, y);
          drawing = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Labels
    ctx.font = "bold 9px system-ui";
    ctx.textAlign = "left";
    let ly = 10;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, leftPad + 4, ly);
      ly += 11;
    }
  }, [series, totalPackets, height]);

  const idxFromEvent = useCallback(
    (clientX: number): number | null => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container || totalPackets < 2) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const w = container.clientWidth;
      const leftPad = 40;
      const rightPad = 8;
      const chartW = w - leftPad - rightPad;
      const clickFrac = (x - leftPad) / chartW;
      if (!timeFracs || timeFracs.length === 0) {
        const idx = Math.round(clickFrac * (totalPackets - 1));
        return idx >= 0 && idx < totalPackets ? idx : null;
      }
      let lo = 0,
        hi = timeFracs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (timeFracs[mid] < clickFrac) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(timeFracs[lo - 1] - clickFrac) < Math.abs(timeFracs[lo] - clickFrac)) lo--;
      return lo >= 0 && lo < totalPackets ? lo : null;
    },
    [totalPackets, timeFracs],
  );

  const fracFromEvent = useCallback((clientX: number): number => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return 0;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const w = container.clientWidth;
    return Math.max(0, Math.min(1, (x - 40) / (w - 40 - 8)));
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      onScrubStart?.();
      const idx = idxFromEvent(e.clientX);
      if (idx !== null) onClickIndex(idx);
      onVisualFracChange?.(fracFromEvent(e.clientX));

      const handleMouseMove = (ev: MouseEvent) => {
        const i = idxFromEvent(ev.clientX);
        if (i !== null) onClickIndex(i);
        onVisualFracChange?.(fracFromEvent(ev.clientX));
      };
      const handleMouseUp = () => {
        onVisualFracChange?.(null);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [idxFromEvent, fracFromEvent, onClickIndex, onScrubStart, onVisualFracChange],
  );

  return (
    <div ref={containerRef} className="w-full relative" style={{ height }} onMouseDown={handleMouseDown}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full cursor-crosshair rounded bg-app-surface/40" />
    </div>
  );
}
