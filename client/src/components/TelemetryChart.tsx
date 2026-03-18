import { useRef, useEffect, useCallback } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

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
}

const SYNC_INSTANCES = new Map<string, uPlot.SyncPubSub>();

function getSync(key: string): uPlot.SyncPubSub {
  if (!SYNC_INSTANCES.has(key)) {
    SYNC_INSTANCES.set(key, uPlot.sync(key));
  }
  return SYNC_INSTANCES.get(key)!;
}

export function TelemetryChart({ data, syncKey, height = 200, title, fillColors }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const buildOpts = useCallback(
    (width: number): uPlot.Options => {
      const series: uPlot.Series[] = [
        { label: "Distance (m)" },
        ...data.labels.map((label, i) => ({
          label,
          stroke: data.colors[i],
          width: 1.5,
          fill: fillColors?.[i] ?? undefined,
        })),
      ];

      const opts: uPlot.Options = {
        width,
        height,
        title: title || undefined,
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
        axes: [
          {
            stroke: "#64748b",
            grid: { stroke: "rgba(100, 116, 139, 0.15)", width: 1 },
            ticks: { stroke: "rgba(100, 116, 139, 0.3)", width: 1 },
            font: "11px ui-monospace, monospace",
          },
          {
            stroke: "#64748b",
            grid: { stroke: "rgba(100, 116, 139, 0.15)", width: 1 },
            ticks: { stroke: "rgba(100, 116, 139, 0.3)", width: 1 },
            font: "11px ui-monospace, monospace",
          },
        ],
        series,
      };

      return opts;
    },
    [data.labels, data.colors, syncKey, height, title, fillColors]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const uplotData: uPlot.AlignedData = [data.distance, ...data.values];

    // Ensure sync instance exists
    if (syncKey) getSync(syncKey);

    plotRef.current = new uPlot(buildOpts(rect.width), uplotData, el);

    return () => {
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
    <div ref={containerRef} className="w-full [&_.u-title]:text-slate-400 [&_.u-title]:text-xs [&_.u-title]:font-semibold [&_.u-title]:uppercase [&_.u-title]:tracking-wider [&_.u-legend]:text-slate-400 [&_.u-legend]:text-xs [&_.u-series]:px-1" />
  );
}
