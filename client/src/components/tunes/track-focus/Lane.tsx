import { useEffect, useRef, useState } from "react";
import { useMeasuredWidth } from "./use-measured-width";

export interface LaneProps {
  /** SVG viewbox height in local units; width tracks the parent's pixel width. */
  height?: number;
  /** Y-domain the lane maps to the drawable area, [min, max]. */
  domain: [number, number];
  /** Corner fractions (0..1) to draw as dashed vertical gridlines. */
  cornerFracs?: number[];
  /** Cursor position (0..1), or null to hide the cursor line. */
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
  /** Optional heading rendered directly above timeline. */
  title?: React.ReactNode;
  /** Extra content drawn inside the plot area (polylines, markers) — receives
   *  the lane's x/y scale functions so children can position themselves. */
  children: (scale: { x: (f: number) => number; y: (v: number) => number; x0: number; x1: number; y0: number; y1: number }) => React.ReactNode;
  /** Optional tooltip renderer keyed by hovered fraction. */
  tooltip?: (f: number) => React.ReactNode;
  className?: string;
  /** Optional issue/annotation positions (0..1) drawn over timeline. */
  annotationFracs?: number[];
  /** Plot-area background fill. Defaults to the slate wash; pass "transparent"
   *  to let the surrounding panel show through. */
  bgFill?: string;
  visibleRange?: { start: number; end: number } | null;
  onRangeSelect?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}

/**
 * Shared SVG lane chart: fraction-of-lap x-axis, a caller-supplied y-domain,
 * dashed gridlines at corner fractions, a synced cursor line, and mouse
 * tracking that reports the hovered fraction up to the parent (which owns
 * the single cross-lane `cursorFrac`).
 */
export function Lane({ height = 100, domain, cornerFracs, cursorFrac, onCursorFrac, title, children, tooltip, className, annotationFracs, bgFill, visibleRange, onRangeSelect, onZoomOut }: LaneProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { ref: wrapRef, width: bw } = useMeasuredWidth<HTMLDivElement>();
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const x0 = 6, x1 = bw - 6, y0 = 6, y1 = height - 6;
  const [min, max] = domain;
  const rangeStart = visibleRange?.start ?? 0, rangeEnd = visibleRange?.end ?? 1;
  const x = (f: number) => x0 + ((f - rangeStart) / Math.max(1e-9, rangeEnd - rangeStart)) * (x1 - x0);
  const y = (v: number) => y1 - ((v - min) / (max - min)) * (y1 - y0);
  function fracFromEvent(e: React.MouseEvent<SVGSVGElement>): number {
    const rect = svgRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, rangeStart + ((e.clientX - rect.left) / rect.width) * (rangeEnd - rangeStart)));
  }
  useEffect(() => {
    if (dragStart == null) return;
    const finish = () => {
      if (dragFrac != null && Math.abs(dragFrac - dragStart) >= 0.01) onRangeSelect?.(dragStart, dragFrac);
      setDragStart(null); setDragFrac(null);
    };
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [dragStart, dragFrac, onRangeSelect]);
  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const f = fracFromEvent(e); setHoverFrac(f);
    if (dragStart != null) setDragFrac(f); else onCursorFrac(f);
  }
  function onLeave() { setHoverFrac(null); if (dragStart == null) onCursorFrac(null); }
  return (
    <div ref={wrapRef} className="relative">
      {title && <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">{title}</div>}
      <svg ref={svgRef} viewBox={`0 0 ${bw} ${height}`} width="100%" height={height} preserveAspectRatio="none" className={className} style={{ cursor: onRangeSelect ? "crosshair" : "default" }} onMouseMove={onMove} onMouseLeave={onLeave} onMouseDown={(e) => onRangeSelect && setDragStart(fracFromEvent(e))} onDoubleClick={() => onZoomOut?.()}>
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={bgFill ?? "var(--app-surface-alt)"} fillOpacity={bgFill == null ? 0.35 : 1} rx={4} />
        {cornerFracs?.map((f) => <line key={f} x1={x(f)} x2={x(f)} y1={y0} y2={y1} stroke="var(--app-border)" strokeDasharray="2 4" opacity={0.8} />)}
        {annotationFracs?.map((f, index) => <line key={`annotation-${index}-${f}`} x1={x(f)} x2={x(f)} y1={y0} y2={y1} stroke="white" strokeDasharray="2 4" strokeWidth={1} opacity={0.9} />)}
        {children({ x, y, x0, x1, y0, y1 })}
        {cursorFrac != null && <line x1={x(cursorFrac)} x2={x(cursorFrac)} y1={y0} y2={y1} stroke="var(--app-accent)" strokeWidth={1.2} opacity={0.9} />}
        {dragStart != null && dragFrac != null && <rect x={Math.min(x(dragStart), x(dragFrac))} y={y0} width={Math.abs(x(dragFrac) - x(dragStart))} height={y1-y0} fill="var(--app-accent)" opacity={0.12} />}
      </svg>
      {tooltip && (hoverFrac != null || cursorFrac != null) && (() => { const tooltipFrac = hoverFrac ?? cursorFrac!; return (
        <div className="absolute z-10 pointer-events-none bg-app-surface border border-app-border rounded px-2 py-1.5 shadow-lg text-app-compact" style={{ left: `${((tooltipFrac - rangeStart) / Math.max(1e-9, rangeEnd - rangeStart)) * 100}%`, top: 0, transform: tooltipFrac > (rangeStart + rangeEnd) / 2 ? "translate(-105%, 0)" : "translate(5%, 0)" }}>
          {tooltip(tooltipFrac)}
        </div>
      ); })()}
    </div>
  );
}
