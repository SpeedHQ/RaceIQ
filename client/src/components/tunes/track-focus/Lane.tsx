import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { resolveCssColor } from "../../../lib/rendering/css-values";

export interface AnnotationMarker {
  frac: number;
  color: string;
}

export interface LaneSeries {
  x: ArrayLike<number>;
  values: ArrayLike<number>;
  color: string;
  width?: number;
  dash?: number[];
}

export interface LaneHorizontalLine {
  value: number;
  color: string;
  width?: number;
  opacity?: number;
  dash?: number[];
}

export interface LaneSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width?: number;
  opacity?: number;
}

export interface LaneProps {
  height?: number;
  domain: [number, number];
  cornerFracs?: number[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  title?: React.ReactNode;
  series: LaneSeries[];
  tooltip?: (f: number) => React.ReactNode;
  className?: string;
  annotationMarkers?: AnnotationMarker[];
  bgFill?: string;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
  horizontalLines?: LaneHorizontalLine[];
  segments?: LaneSegment[];
}

const TRACK_LANE_SYNC_KEY = "track-focus-lanes";
const PLOT_PAD = 6;
const DRAG_THRESHOLD_PX = 3;

function alignedData(series: LaneSeries[]): uPlot.AlignedData {
  if (series.length === 0) return [[]];
  return [Array.from(series[0].x), ...series.map((item) => Array.from(item.values))];
}

/**
 * Headless uPlot lane: canvas series and cursor, Track-specific annotations,
 * controlled cross-map cursor, range selection, and existing tooltip content.
 * Axes, legend, point markers, and uPlot value readouts stay disabled.
 */
export function Lane({
  height = 100,
  domain,
  cornerFracs = [],
  cursorFrac,
  onCursorFrac,
  title,
  series,
  tooltip,
  className,
  annotationMarkers = [],
  bgFill,
  visibleRange,
  onRangeSelect,
  onZoomOut,
  horizontalLines = [],
  segments = [],
}: LaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const onCursorFracRef = useRef(onCursorFrac);
  const overlayRef = useRef({ cornerFracs, annotationMarkers, horizontalLines, segments });
  const frameRef = useRef<number | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const dragRef = useRef<{ startFrac: number; startClientX: number } | null>(null);
  const [dragRange, setDragRange] = useState<{ start: number; end: number } | null>(null);

  onCursorFracRef.current = onCursorFrac;
  overlayRef.current = { cornerFracs, annotationMarkers, horizontalLines, segments };

  const styleKey = useMemo(
    () => series.map((item) => `${item.color}:${item.width ?? 1}:${item.dash?.join(",") ?? ""}`).join("|"),
    [series],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const publishCursor = (value: number | null) => {
      pendingCursorRef.current = value;
      if (frameRef.current != null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        onCursorFracRef.current(pendingCursorRef.current);
      });
    };

    const drawOverlays = (plot: uPlot) => {
      const { ctx } = plot;
      const ratio = window.devicePixelRatio || 1;
      const x = (value: number) => plot.valToPos(value, "x", true);
      const y = (value: number) => plot.valToPos(value, "y", true);
      const top = plot.bbox.top;
      const bottom = top + plot.bbox.height;
      const left = plot.bbox.left;
      const right = left + plot.bbox.width;
      const overlays = overlayRef.current;

      ctx.save();
      for (const frac of overlays.cornerFracs) {
        const px = x(frac);
        ctx.beginPath();
        ctx.setLineDash([2 * ratio, 4 * ratio]);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = ratio;
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
        ctx.stroke();
      }
      for (const marker of overlays.annotationMarkers) {
        const px = x(marker.frac);
        ctx.beginPath();
        ctx.setLineDash([2 * ratio, 4 * ratio]);
        ctx.strokeStyle = resolveCssColor(marker.color);
        ctx.lineWidth = ratio;
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
        ctx.stroke();
      }
      for (const line of overlays.horizontalLines) {
        ctx.beginPath();
        ctx.setLineDash((line.dash ?? []).map((part) => part * ratio));
        ctx.strokeStyle = resolveCssColor(line.color);
        ctx.globalAlpha = line.opacity ?? 1;
        ctx.lineWidth = (line.width ?? 1) * ratio;
        const py = y(line.value);
        ctx.moveTo(left, py);
        ctx.lineTo(right, py);
        ctx.stroke();
      }
      for (const segment of overlays.segments) {
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.strokeStyle = resolveCssColor(segment.color);
        ctx.globalAlpha = segment.opacity ?? 1;
        ctx.lineWidth = (segment.width ?? 1) * ratio;
        ctx.moveTo(x(segment.x1), y(segment.y1));
        ctx.lineTo(x(segment.x2), y(segment.y2));
        ctx.stroke();
      }
      ctx.restore();
    };

    const opts: uPlot.Options = {
      width: Math.max(1, container.clientWidth),
      height,
      padding: [PLOT_PAD, PLOT_PAD, PLOT_PAD, PLOT_PAD],
      legend: { show: false },
      axes: [{ show: false }, { show: false }],
      cursor: {
        sync: { key: TRACK_LANE_SYNC_KEY, setSeries: false },
        points: { show: false },
        drag: { x: false, y: false, setScale: false },
      },
      scales: {
        x: { time: false, range: () => [visibleRange?.start ?? 0, visibleRange?.end ?? 1] },
        y: { range: () => domain },
      },
      series: [
        {},
        ...series.map((item) => ({
          stroke: resolveCssColor(item.color),
          width: item.width ?? 1,
          dash: item.dash,
          points: { show: false },
        })),
      ],
      hooks: {
        draw: [drawOverlays],
        setCursor: [
          (plot) => {
            if (!plot.over.matches(":hover") || dragRef.current) return;
            const left = plot.cursor.left;
            if (left == null || left < 0) return;
            publishCursor(Math.max(0, Math.min(1, plot.posToVal(left, "x"))));
          },
        ],
      },
    };

    const plot = new uPlot(opts, alignedData(series), container);
    plotRef.current = plot;

    const fracFromEvent = (event: PointerEvent) => {
      const rect = plot.over.getBoundingClientRect();
      return Math.max(0, Math.min(1, plot.posToVal(event.clientX - rect.left, "x")));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!onRangeSelect) return;
      const startFrac = fracFromEvent(event);
      dragRef.current = { startFrac, startClientX: event.clientX };
      setDragRange({ start: startFrac, end: startFrac });
      plot.over.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) setDragRange({ start: drag.startFrac, end: fracFromEvent(event) });
    };
    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const endFrac = fracFromEvent(event);
      dragRef.current = null;
      setDragRange(null);
      if (Math.abs(event.clientX - drag.startClientX) >= DRAG_THRESHOLD_PX && endFrac !== drag.startFrac) {
        onRangeSelect?.(Math.min(drag.startFrac, endFrac), Math.max(drag.startFrac, endFrac));
      }
    };
    const onPointerLeave = () => {
      if (!dragRef.current) publishCursor(null);
    };
    const onDoubleClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onZoomOut?.();
    };

    plot.over.addEventListener("pointerdown", onPointerDown);
    plot.over.addEventListener("pointermove", onPointerMove);
    plot.over.addEventListener("pointerup", finishDrag);
    plot.over.addEventListener("pointercancel", finishDrag);
    plot.over.addEventListener("pointerleave", onPointerLeave);
    plot.over.addEventListener("dblclick", onDoubleClick);

    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) plot.setSize({ width: entry.contentRect.width, height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      plot.over.removeEventListener("pointerdown", onPointerDown);
      plot.over.removeEventListener("pointermove", onPointerMove);
      plot.over.removeEventListener("pointerup", finishDrag);
      plot.over.removeEventListener("pointercancel", finishDrag);
      plot.over.removeEventListener("pointerleave", onPointerLeave);
      plot.over.removeEventListener("dblclick", onDoubleClick);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      plot.destroy();
      plotRef.current = null;
    };
  }, [domain, height, onRangeSelect, onZoomOut, series.length, styleKey, visibleRange?.end, visibleRange?.start]);

  useEffect(() => {
    plotRef.current?.setData(alignedData(series));
  }, [series]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || plot.over.matches(":hover")) return;
    plot.setCursor({ left: cursorFrac == null ? -10 : plot.valToPos(cursorFrac, "x"), top: -10 }, false);
  }, [cursorFrac]);

  useEffect(() => {
    plotRef.current?.redraw();
  }, [annotationMarkers, cornerFracs, horizontalLines, segments]);

  const rangeStart = visibleRange?.start ?? 0;
  const rangeEnd = visibleRange?.end ?? 1;
  const dragLeft = dragRange == null ? 0 : ((Math.min(dragRange.start, dragRange.end) - rangeStart) / Math.max(1e-9, rangeEnd - rangeStart)) * 100;
  const dragWidth = dragRange == null ? 0 : (Math.abs(dragRange.end - dragRange.start) / Math.max(1e-9, rangeEnd - rangeStart)) * 100;

  return (
    <div className="relative">
      {title && <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">{title}</div>}
      <div
        data-track-telemetry-lane
        className={`relative w-full overflow-hidden rounded ${className ?? ""}`}
        style={{ height, cursor: onRangeSelect ? "crosshair" : "default", background: bgFill ?? "transparent" }}
      >
        <div ref={containerRef} className="h-full w-full" />
        {dragRange && <div className="pointer-events-none absolute inset-y-1.5 bg-app-accent/10" style={{ left: `${dragLeft}%`, width: `${dragWidth}%` }} />}
      </div>
      {tooltip && cursorFrac != null && (
        <div
          className="absolute z-10 pointer-events-none bg-app-surface border border-app-border rounded px-2 py-1.5 shadow-lg text-app-compact"
          style={{ left: `${((cursorFrac - rangeStart) / Math.max(1e-9, rangeEnd - rangeStart)) * 100}%`, top: title ? 20 : 0, transform: cursorFrac > (rangeStart + rangeEnd) / 2 ? "translate(-105%, 0)" : "translate(5%, 0)" }}
        >
          {tooltip(cursorFrac)}
        </div>
      )}
    </div>
  );
}
