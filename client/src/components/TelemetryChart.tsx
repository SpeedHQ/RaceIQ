import { useCallback, useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
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

export function TelemetryChart({ data, syncKey, height = 200, title, fillColors, onCursorMove }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
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
                const sel = getOverOffset(e.offsetX);
                if (sel) setDragSel(sel);
              };

              const onUp = () => {
                if (dragging) {
                  dragging = false;
                  setDragSel(null);
                }
              };

              over.addEventListener("pointerdown", onDown);
              window.addEventListener("pointerup", onUp);

              cleanupOverlayRef.current = () => {
                over.removeEventListener("pointerdown", onDown);
                window.removeEventListener("pointerup", onUp);
              };
            },
          ],
          setCursor: [
            (upl: uPlot) => {
              if (!onCursorMoveRef.current) return;
              const idx = upl.cursor.idx;
              if (idx != null && idx >= 0 && idx < data.distance.length) {
                onCursorMoveRef.current(data.distance[idx]);
              }
            },
          ],
        },
      };

      return opts;
    },
    [data.labels, data.colors, syncKey, height, title, fillColors, data.distance],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const uplotData: uPlot.AlignedData = [data.distance, ...data.values];

    if (syncKey) getSync(syncKey);

    plotRef.current = new uPlot(buildOpts(rect.width), uplotData, el);

    return () => {
      cleanupOverlayRef.current?.();
      cleanupOverlayRef.current = null;
      plotRef.current?.destroy();
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
          <span className="absolute right-1 text-app-caption text-app-text-dim">Click &amp; drag to zoom · Double-click to reset</span>
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
