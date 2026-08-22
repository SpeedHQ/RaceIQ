import { useCallback, useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { clampVisibleRange, type ChartRange } from "../lib/chart-range";
import { resolveCssColor, resolveCssFont } from "../lib/rendering/css-values";

interface Props {
  data: {
    distance: number[];
    values: number[][];
    labels: string[];
    colors: string[];
  };
  syncKey?: string;
  height?: number;
  title?: string;
  fillColors?: (string | null)[];
  onCursorMove?: (distance: number | null) => void;
  onRangeSelect?: (start: number, end: number) => void;
  onResetZoom?: () => void;
}


interface DragSel {
  startPx: number;
  overLeft: number;
  overTop: number;
  overHeight: number;
}

const SYNC_INSTANCES = new Map<string, uPlot.SyncPubSub>();

function getSync(key: string): uPlot.SyncPubSub {
  if (!SYNC_INSTANCES.has(key)) {
    SYNC_INSTANCES.set(key, uPlot.sync(key));
  }
  return SYNC_INSTANCES.get(key)!;
}


export function pixelAlignedCursorBBox(x: number, y: number, size: number): uPlot.BBox {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  return {
    left: roundedX - size / 2,
    top: roundedY - size / 2,
    width: size,
    height: size,
  };
}

const CURSOR_POINT_SIZE = 6;

export function TelemetryChart({ data, syncKey, height = 200, title, fillColors, onCursorMove, onRangeSelect, onResetZoom }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const visibleRangeRef = useRef<ChartRange | null>(null);
  const onCursorMoveRef = useRef(onCursorMove);
  onCursorMoveRef.current = onCursorMove;
  const cleanupOverlayRef = useRef<(() => void) | null>(null);
  const [dragSel, setDragSel] = useState<DragSel | null>(null);
  const buildOpts = useCallback(
    (width: number): uPlot.Options => {
      const series: uPlot.Series[] = [
        { label: "Distance (m)" },
        ...data.labels.map((label, i) => ({
          label,
          stroke: resolveCssColor(data.colors[i]),
          width: 1.5,
          fill: fillColors?.[i] ? resolveCssColor(fillColors[i]!) : undefined,
        })),
      ];
      const axisStroke = resolveCssColor("var(--app-text-dim)");
      const gridStroke = resolveCssColor("color-mix(in srgb, var(--app-text-dim) 15%, transparent)");
      const tickStroke = resolveCssColor("color-mix(in srgb, var(--app-text-dim) 30%, transparent)");
      const axis = (): uPlot.Axis => ({
        stroke: axisStroke,
        grid: { stroke: gridStroke, width: 1 },
        ticks: { stroke: tickStroke, width: 1 },
        font: resolveCssFont("var(--text-app-compact) var(--font-mono)"),
      });

      const opts: uPlot.Options = {
        width,
        height,
        padding: [4, 4, 0, 4],
        cursor: {
          sync: syncKey
            ? {
                key: syncKey,
                setSeries: true,
              }
            : undefined,
          points: {
            size: CURSOR_POINT_SIZE,
            bbox: (upl: uPlot, seriesIdx: number) => {
              const index = upl.cursor.idxs?.[seriesIdx];
              const xValue = index == null ? undefined : upl.data[0]?.[index];
              const yValue = index == null ? undefined : upl.data[seriesIdx]?.[index];
              const scale = upl.series[seriesIdx]?.scale;
              if (
                index == null ||
                xValue == null ||
                yValue == null ||
                scale == null ||
                !Number.isFinite(xValue) ||
                !Number.isFinite(yValue)
              ) {
                return { left: -1, top: -1, width: 0, height: 0 };
              }
              const valueX = upl.valToPos(xValue, "x");
              const x = upl.cursor.left ?? valueX;
              const y = upl.valToPos(yValue, scale);
              return Number.isFinite(x) && Number.isFinite(y)
                ? pixelAlignedCursorBBox(x, y, CURSOR_POINT_SIZE)
                : { left: -1, top: -1, width: 0, height: 0 };
            },
          },
          drag: { x: true, y: false },
        },
        scales: {
          x: { time: false },
        },
        axes: [axis(), axis()],
        series,
        hooks: {
          ready: [
            (upl: uPlot) => {
              // Style title and legend via direct DOM (reliable across Tailwind versions)
              const titleEl = upl.root.querySelector(".u-title") as HTMLElement | null;
              if (titleEl) {
                titleEl.style.fontSize = "var(--text-app-caption)";
                titleEl.style.fontWeight = "var(--font-weight-semibold)";
              }

              const legendEl = upl.root.querySelector(".u-legend") as HTMLElement | null;
              if (legendEl) legendEl.style.fontSize = "var(--text-app-caption)";

              // Drag start line overlay
              const over = upl.over;
              let dragging = false;
              let pointerDownClientX: number | null = null;
              let pointerDownPlotX: number | null = null;
              const DRAG_THRESHOLD_PX = 3;

              const getOverOffset = (startPx: number): DragSel | null => {
                const overRect = over.getBoundingClientRect();
                const outerRect = outerRef.current?.getBoundingClientRect();
                if (!outerRect) return null;
                return {
                  startPx,
                  overLeft: overRect.left - outerRect.left,
                  overTop: overRect.top - outerRect.top,
                  overHeight: overRect.height,
                };
              };

              const onDown = (e: PointerEvent) => {
                dragging = true;
                pointerDownClientX = e.clientX;
                pointerDownPlotX = e.offsetX;
                const sel = getOverOffset(e.offsetX);
                if (sel) setDragSel(sel);
              };

              const onUp = (e: PointerEvent) => {
                if (!dragging) return;
                dragging = false;
                setDragSel(null);
                const moved = pointerDownClientX == null ? 0 : Math.abs(e.clientX - pointerDownClientX);
                const startPx = pointerDownPlotX;
                pointerDownClientX = null;
                pointerDownPlotX = null;
                const overRect = over.getBoundingClientRect();
                const endPx = e.clientX - overRect.left;
                const start = startPx == null ? null : upl.posToVal(startPx, "x");
                const end = upl.posToVal(endPx, "x");
                if (moved < DRAG_THRESHOLD_PX) {
                  return;
                }
                if (start != null && end != null && end > start) {
                  onRangeSelect?.(start, end);
                }
              };

              const onDoubleClick = () => {
                onResetZoom?.();
              };
              over.addEventListener("pointerdown", onDown);
              window.addEventListener("pointerup", onUp);
              over.addEventListener("dblclick", onDoubleClick);

              cleanupOverlayRef.current = () => {
                over.removeEventListener("pointerdown", onDown);
                window.removeEventListener("pointerup", onUp);
                over.removeEventListener("dblclick", onDoubleClick);
              };
            },
          ],
          setCursor: [
            (upl: uPlot) => {
              const idx = upl.cursor.idx;
              if (idx != null && idx >= 0 && idx < data.distance.length) {
                onCursorMoveRef.current?.(data.distance[idx]);
              } else {
                onCursorMoveRef.current?.(null);
              }
            },
          ],
        },
      };
      return opts;
    },
    [data.labels, data.colors, syncKey, height, title, fillColors, data.distance, onRangeSelect, onResetZoom],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const uplotData: uPlot.AlignedData = [data.distance, ...data.values];

    if (syncKey) getSync(syncKey);

    const plot = new uPlot(buildOpts(rect.width), uplotData, el);
    plotRef.current = plot;
    const domainMin = data.distance[0];
    const domainMax = data.distance.at(-1);
    const visibleRange =
      domainMin != null && domainMax != null && visibleRangeRef.current
        ? clampVisibleRange(visibleRangeRef.current, { min: domainMin, max: domainMax })
        : null;
    if (visibleRange) plot.setScale("x", visibleRange);

    return () => {
      const currentPlot = plotRef.current;
      if (currentPlot) {
        const { min, max } = currentPlot.scales.x;
        if (min != null && max != null && max > min) visibleRangeRef.current = { min, max };
      }
      cleanupOverlayRef.current?.();
      cleanupOverlayRef.current = null;
      currentPlot?.destroy();
      plotRef.current = null;
    };
  }, [buildOpts, data, syncKey]);

  // Resize handler
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (plotRef.current) {
          plotRef.current.setSize({
            width: entry.contentRect.width,
            height,
          });
        }
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [height]);

  return (
    <div className="w-full">
      {title && (
        <div className="relative flex items-center justify-center px-1 pb-0.5">
          <span className="text-app-caption font-semibold uppercase tracking-wider text-app-text-secondary">{title}</span>
          <span className="absolute right-1 hidden text-app-caption text-app-text-dim @3xl/workspace:inline">Click &amp; drag to zoom · Double-click to reset</span>
        </div>
      )}
      <div ref={outerRef} className="relative w-full">
        <div ref={containerRef} className="w-full" />
        {dragSel && (
          <div
            className="absolute pointer-events-none w-px bg-app-text-secondary/70"
            style={{
              left: dragSel.overLeft + dragSel.startPx,
              top: dragSel.overTop,
              height: dragSel.overHeight,
            }}
          />
        )}
      </div>
    </div>
  );
}
