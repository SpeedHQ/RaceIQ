import { useRef, useState } from "react";
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
  /** Extra content drawn inside the plot area (polylines, markers) — receives
   *  the lane's x/y scale functions so children can position themselves. */
  children: (scale: { x: (f: number) => number; y: (v: number) => number; x0: number; x1: number; y0: number; y1: number }) => React.ReactNode;
  /** Optional tooltip renderer keyed by the hovered fraction. */
  tooltip?: (f: number) => React.ReactNode;
  className?: string;
  /** Plot-area background fill. Defaults to the slate wash; pass "transparent"
   *  to let the surrounding panel show through. */
  bgFill?: string;
}

/**
 * Shared SVG lane chart: fraction-of-lap x-axis, a caller-supplied y-domain,
 * dashed gridlines at corner fractions, a synced cursor line, and mouse
 * tracking that reports the hovered fraction up to the parent (which owns
 * the single cross-lane `cursorFrac`).
 */
export function Lane({ height = 100, domain, cornerFracs, cursorFrac, onCursorFrac, children, tooltip, className, bgFill }: LaneProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { ref: wrapRef, width: bw } = useMeasuredWidth<HTMLDivElement>();
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const x0 = 6;
  const x1 = bw - 6;
  const y0 = 6;
  const y1 = height - 6;
  const [min, max] = domain;
  const x = (f: number) => x0 + f * (x1 - x0);
  const y = (v: number) => y1 - ((v - min) / (max - min)) * (y1 - y0);

  function fracFromEvent(e: React.MouseEvent<SVGSVGElement>): number {
    const rect = svgRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const f = fracFromEvent(e);
    setHoverFrac(f);
    onCursorFrac(f);
  }

  function onLeave() {
    setHoverFrac(null);
    onCursorFrac(null);
  }

  return (
    <div ref={wrapRef} className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${bw} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className={className}
        style={{ cursor: "crosshair" }}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={bgFill ?? "var(--app-surface-alt)"} fillOpacity={bgFill == null ? 0.35 : 1} rx={4} />
        {min < 0 && max > 0 && <line x1={x0} x2={x1} y1={y(0)} y2={y(0)} stroke="var(--app-border)" strokeWidth={1} />}
        {cornerFracs?.map((f) => (
          <line key={f} x1={x(f)} x2={x(f)} y1={y0} y2={y1} stroke="var(--app-border)" strokeDasharray="2 4" />
        ))}
        {children({ x, y, x0, x1, y0, y1 })}
        {cursorFrac != null && <line x1={x(cursorFrac)} x2={x(cursorFrac)} y1={y0} y2={y1} stroke="var(--app-accent)" strokeWidth={1.2} opacity={0.9} />}
      </svg>
      {tooltip && hoverFrac != null && (
        <div
          className="absolute z-10 pointer-events-none bg-app-surface border border-app-border rounded px-2 py-1.5 shadow-lg text-app-compact"
          style={{
            left: `${hoverFrac * 100}%`,
            top: 0,
            transform: hoverFrac > 0.5 ? "translate(-105%, 0)" : "translate(5%, 0)",
          }}
        >
          {tooltip(hoverFrac)}
        </div>
      )}
    </div>
  );
}
