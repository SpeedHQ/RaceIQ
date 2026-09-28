import { useCallback, useEffect, useRef, useState } from "react";
import { syncCanvasSize } from "../../lib/rendering/canvas-size";
import { getSemanticCanvasContext } from "../../lib/rendering/css-canvas";

const TELEMETRY_GAP_SECONDS = 0.1;
const TELEMETRY_GAP_TOLERANCE_SECONDS = 0.001;

export function hasTelemetryGap(previousTime: number, currentTime: number): boolean {
  return currentTime - previousTime > TELEMETRY_GAP_SECONDS + TELEMETRY_GAP_TOLERANCE_SECONDS;
}

export interface ChartSeries {
  data: number[];
  color: string;
  label: string;
}
function axisDecimals(range: number): number {
  if (range >= 10) return 0;
  if (range >= 1) return 1;
  if (range >= 0.1) return 2;
  return 3;
}

function axisValue(value: number, range: number): string {
  return value.toFixed(axisDecimals(range));
}

function chartDomain(series: ChartSeries[]): [number, number] {
  const values = series.flatMap((item) => item.data).filter(Number.isFinite);
  if (values.length === 0) return [-1, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const observedRange = max - min;
  // Scale padding to observed values so small telemetry changes remain visible.
  const pad = observedRange > 0 ? observedRange * 0.08 : Math.max(Math.abs(min) * 0.05, 1);
  let domainMin = min - pad;
  let domainMax = max + pad;
  // Keep zero visible when data crosses it; don't force zero into one-sided charts.
  if (min <= 0 && max >= 0) {
    domainMin = Math.min(domainMin, 0);
    domainMax = Math.max(domainMax, 0);
  }
  return [domainMin, domainMax];
}

export function TelemetryChart({
  series,
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
  totalPackets: number;
  onClickIndex: (idx: number) => void;
  onScrubStart?: () => void;
  height?: number;
  timeFracs?: number[];
  times?: number[];
  visualTimeFrac?: number | null;
  onVisualFracChange?: (frac: number | null) => void;
}) {
  const [containerWidth, setContainerWidth] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrubCleanupRef = useRef<(() => void) | null>(null);
  const lastScrubIndexRef = useRef<number | null>(null);
  const visualFracRafRef = useRef<number | null>(null);
  const pendingVisualFracRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => setContainerWidth(container.clientWidth));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;

    const w = container.clientWidth;
    const h = height;
    syncCanvasSize(canvas, w, h, window.devicePixelRatio || 1, false);
    const scaleX = canvas.width / w;
    const scaleY = canvas.height / h;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const leftPad = 40;
    const rightPad = 8;
    const topPad = 16;
    const botPad = 4;
    const chartW = w - leftPad - rightPad;
    const chartH = h - topPad - botPad;

    if (totalPackets < 2) return;

    const [gMin, gMax] = chartDomain(series);
    const range = gMax - gMin;

    // Y axis ticks (3)
    ctx.font = "var(--text-app-micro) var(--font-mono)";
    ctx.fillStyle = "var(--app-border)";
    ctx.textAlign = "right";
    for (let i = 0; i <= 2; i++) {
      const val = gMin + (range * i) / 2;
      const y = topPad + chartH - (i / 2) * chartH;
      ctx.fillText(axisValue(val, range), leftPad - 4, y + 3);
      ctx.strokeStyle = "color-mix(in srgb, var(--app-text-dim) 8%, transparent)";
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(leftPad, y);
      ctx.lineTo(w - rightPad, y);
      ctx.stroke();
    }

    // Draw gap highlights first (behind data lines)
    if (times && timeFracs) {
      ctx.fillStyle = "color-mix(in srgb, var(--status-danger) 8%, transparent)";
      for (let i = 1; i < times.length; i++) {
        if (hasTelemetryGap(times[i - 1], times[i])) {
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
        if (i > 0 && times && hasTelemetryGap(times[i - 1], times[i])) {
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
    ctx.font = "var(--font-weight-bold) var(--text-app-micro) var(--font-sans)";
    ctx.textAlign = "left";
    let ly = 10;
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillText(s.label, leftPad + 4, ly);
      ly += 11;
    }
  }, [series, totalPackets, height, containerWidth, timeFracs, times]);

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
      scrubCleanupRef.current?.();
      onScrubStart?.();
      lastScrubIndexRef.current = null;
      const emitIndex = (clientX: number) => {
        const idx = idxFromEvent(clientX);
        if (idx !== null && idx !== lastScrubIndexRef.current) {
          lastScrubIndexRef.current = idx;
          onClickIndex(idx);
        }
      };
      const emitVisualFrac = (frac: number | null) => {
        pendingVisualFracRef.current = frac;
        if (visualFracRafRef.current == null) {
          visualFracRafRef.current = requestAnimationFrame(() => {
            visualFracRafRef.current = null;
            onVisualFracChange?.(pendingVisualFracRef.current);
          });
        }
      };
      emitIndex(e.clientX);
      emitVisualFrac(fracFromEvent(e.clientX));

      const handleMouseMove = (ev: MouseEvent) => {
        emitIndex(ev.clientX);
        emitVisualFrac(fracFromEvent(ev.clientX));
      };
      const handleMouseUp = () => {
        if (visualFracRafRef.current != null) {
          cancelAnimationFrame(visualFracRafRef.current);
          visualFracRafRef.current = null;
        }
        pendingVisualFracRef.current = null;
        onVisualFracChange?.(null);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
        scrubCleanupRef.current = null;
      };
      const cleanup = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
      scrubCleanupRef.current = cleanup;
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [idxFromEvent, fracFromEvent, onClickIndex, onScrubStart, onVisualFracChange],
  );

  return (
    // oxlint-disable-next-line a11y/noStaticElementInteractions: canvas scrubbing uses pointer drag; keyboard navigation is provided by the timeline controls
    <div ref={containerRef} className="w-full relative" style={{ height }} onMouseDown={handleMouseDown}>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full cursor-crosshair rounded bg-app-surface/40" />
    </div>
  );
}
