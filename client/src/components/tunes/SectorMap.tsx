import { useMemo, useRef, useState } from "react";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import type { SemanticAnalysisFrame } from "../analyse/track-map/types";
import { useTrackBoundaries } from "../../hooks/track-queries";
import { buildGeometry, extractEdges, type ProjPt, VIEW } from "./track-map-geometry";

interface SectorTimes {
  times: number[];
  boundaryIndices: number[];
}

export interface ReadoutRow {
  label: string;
  value: string;
  color?: string;
}

interface SectorMapProps {
  telemetry: SemanticAnalysisFrame[];
  sectorTimes: SectorTimes | null;
  /** When set, only that sector's segment is lit; the rest are faded. */
  highlight?: number;
  /** Show the source-defined sector time legend under the map. Default true. */
  showTimes?: boolean;
  /** When provided, the track's left/right edges are fetched and drawn faintly. */
  trackOrdinal?: number;
  /** Tooltip content for the hovered frame; when omitted, hover is disabled. */
  readout?: (frame: SemanticAnalysisFrame, fraction: number) => ReadoutRow[];
  /** Reports the hovered telemetry index (or null) so a parent can sync other
   *  views — e.g. draw the cursor value on the range bars. */
  onHover?: (idx: number | null) => void;
  /** Externally-driven marker at a lap fraction (0-1) — e.g. an issue's
   *  location, highlighted when its list item is hovered. */
  markFraction?: number | null;
}

/**
 * SectorMap — a static post-lap track map: the lap's path plotted from its
 * stored positions, split into source-defined sector-coloured segments. Track edges are
 * drawn faintly when the track has geometry. Hovering scrubs the lap like a
 * chart — a marker follows the cursor and a tooltip shows values at that point.
 */
export function SectorMap({ telemetry, sectorTimes, highlight, showTimes = true, trackOrdinal, readout, onHover, markFraction }: SectorMapProps) {
  const { data: bounds } = useTrackBoundaries(trackOrdinal);
  const edges = extractEdges(bounds);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<ProjPt | null>(null);

  const geom = useMemo(() => buildGeometry(telemetry, sectorTimes, edges), [telemetry, sectorTimes, edges]);

  if (!geom) {
    return <div className="p-4 text-xs text-app-text-dim">No position data to draw this lap.</div>;
  }

  const interactive = !!readout;
  const total = telemetry.length;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!interactive || !svgRef.current || !geom) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * VIEW;
    const sy = ((e.clientY - rect.top) / rect.height) * VIEW;
    let best: ProjPt | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of geom.pts) {
      const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    setHover(best);
    onHover?.(best ? best.idx : null);
  }

  function onLeave() {
    setHover(null);
    onHover?.(null);
  }

  const hoverFrame = hover ? telemetry[hover.idx] : null;
  const rows = hover && hoverFrame && readout ? readout(hoverFrame, hover.idx / Math.max(1, total - 1)) : [];

  // External marker (e.g. an issue's location) at a lap fraction.
  let markPt: ProjPt | null = null;
  if (markFraction != null && markFraction >= 0) {
    const target = markFraction * Math.max(1, total - 1);
    let bd = Number.POSITIVE_INFINITY;
    for (const p of geom.pts) {
      const d = Math.abs(p.idx - target);
      if (d < bd) {
        bd = d;
        markPt = p;
      }
    }
  }

  return (
    <div className="p-3">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          className="w-full h-auto"
          role="img"
          aria-label="Lap track map coloured by sector"
          style={{ cursor: interactive ? "crosshair" : undefined }}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          {geom.leftEdge && <polyline points={geom.leftEdge} fill="none" stroke="currentColor" className="text-app-border" strokeWidth={1.5} opacity={0.5} />}
          {geom.rightEdge && <polyline points={geom.rightEdge} fill="none" stroke="currentColor" className="text-app-border" strokeWidth={1.5} opacity={0.5} />}
          <polyline points={geom.allPoints} fill="none" stroke="currentColor" className="text-app-border" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" opacity={0.3} />
          {geom.segments.map((seg, i) => {
            const dim = highlight != null && highlight !== i;
            return (
              <polyline
                key={seg}
                points={seg}
                fill="none"
                stroke={dim ? "currentColor" : SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length]}
                className={dim ? "text-app-border" : undefined}
                strokeWidth={dim ? 2 : 3}
                opacity={dim ? 0.4 : 1}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            );
          })}
          {markPt && (
            <>
              <circle cx={markPt.x} cy={markPt.y} r={7} fill="none" stroke="var(--map-highlight)" strokeWidth={2} />
              <circle cx={markPt.x} cy={markPt.y} r={3} fill="var(--map-highlight)" />
            </>
          )}
          {hover && (
            <>
              <circle cx={hover.x} cy={hover.y} r={5.5} fill="none" stroke="var(--app-accent)" strokeWidth={1.5} />
              <circle cx={hover.x} cy={hover.y} r={2.5} fill="var(--app-accent)" />
            </>
          )}
        </svg>
        {hover && rows.length > 0 && (
          <div
            className="absolute z-10 pointer-events-none bg-app-surface border border-app-border rounded px-2 py-1.5 shadow-lg"
            style={{
              left: `${(hover.x / VIEW) * 100}%`,
              top: `${(hover.y / VIEW) * 100}%`,
              transform: hover.x > VIEW / 2 ? "translate(-108%, -50%)" : "translate(8%, -50%)",
            }}
          >
            <div className="text-app-caption text-app-text-dim mb-0.5 tabular-nums">{Math.round((hover.idx / Math.max(1, total - 1)) * 100)}% lap</div>
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3 text-app-compact font-mono tabular-nums">
                <span className="text-app-text-muted">{r.label}</span>
                <span style={{ color: r.color ?? "var(--app-text)" }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {showTimes && (
        <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${sectorTimes?.times.length ?? 3}, minmax(0, 1fr))` }}>
          {Array.from({ length: sectorTimes?.times.length ?? 3 }, (_, i) => `S${i + 1}`).map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: SECTOR_COLOR_VARS[i % SECTOR_COLOR_VARS.length] }} />
              <span className="text-app-compact text-app-text-muted">{label}</span>
              <span className="text-xs font-mono tabular-nums text-app-text ml-auto">{sectorTimes && sectorTimes.times[i] > 0 ? sectorTimes.times[i].toFixed(3) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
