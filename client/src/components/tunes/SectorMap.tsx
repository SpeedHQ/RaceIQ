import type { TelemetryPacket } from "@shared/types";
import { useMemo, useRef, useState } from "react";
import { useTrackBoundaries } from "../../hooks/queries";

interface SectorTimes {
  times: [number, number, number];
  s1Idx: number;
  s2Idx: number;
}

export interface ReadoutRow {
  label: string;
  value: string;
  color?: string;
}

interface SectorMapProps {
  telemetry: TelemetryPacket[];
  sectorTimes: SectorTimes | null;
  /** When set (0-2), only that sector's segment is lit; the rest are faded. */
  highlight?: number;
  /** Show the S1/S2/S3 time legend under the map. Default true. */
  showTimes?: boolean;
  /** When provided, the track's left/right edges are fetched and drawn faintly. */
  trackOrdinal?: number;
  /** Tooltip content for the hovered frame; when omitted, hover is disabled. */
  readout?: (frame: TelemetryPacket, fraction: number) => ReadoutRow[];
  /** Reports the hovered telemetry index (or null) so a parent can sync other
   *  views — e.g. draw the cursor value on the range bars. */
  onHover?: (idx: number | null) => void;
  /** Externally-driven marker at a lap fraction (0-1) — e.g. an issue's
   *  location, highlighted when its list item is hovered. */
  markFraction?: number | null;
}

interface Pt {
  x: number;
  z: number;
}
interface ProjPt {
  x: number;
  y: number;
  idx: number;
}

const SECTOR_COLORS = ["#f87171", "#60a5fa", "#facc15"] as const;
const SECTOR_LABELS = ["S1", "S2", "S3"] as const;
const VIEW = 300;
const PAD = 14;
const TARGET_POINTS = 600;

/**
 * SectorMap — a static post-lap track map: the lap's path plotted from its
 * stored positions, split into three sector-coloured segments. Track edges are
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
                stroke={dim ? "currentColor" : SECTOR_COLORS[i]}
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
              <circle cx={markPt.x} cy={markPt.y} r={7} fill="none" stroke="#fbbf24" strokeWidth={2} />
              <circle cx={markPt.x} cy={markPt.y} r={3} fill="#fbbf24" />
            </>
          )}
          {hover && (
            <>
              <circle cx={hover.x} cy={hover.y} r={5.5} fill="none" stroke="var(--color-app-accent, #22d3ee)" strokeWidth={1.5} />
              <circle cx={hover.x} cy={hover.y} r={2.5} fill="var(--color-app-accent, #22d3ee)" />
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
            <div className="text-[10px] text-app-text-dim mb-0.5 tabular-nums">{Math.round((hover.idx / Math.max(1, total - 1)) * 100)}% lap</div>
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3 text-[11px] font-mono tabular-nums">
                <span className="text-app-text-muted">{r.label}</span>
                <span style={{ color: r.color ?? "var(--color-app-text, #e6edf3)" }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {showTimes && (
        <div className="mt-2 grid grid-cols-3 gap-2">
          {SECTOR_LABELS.map((label, i) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: SECTOR_COLORS[i] }} />
              <span className="text-[11px] text-app-text-muted">{label}</span>
              <span className="text-xs font-mono tabular-nums text-app-text ml-auto">{sectorTimes && sectorTimes.times[i] > 0 ? sectorTimes.times[i].toFixed(3) : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Geometry {
  allPoints: string;
  segments: [string, string, string];
  leftEdge: string | null;
  rightEdge: string | null;
  pts: ProjPt[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEdges(bounds: any): { left: Pt[]; right: Pt[] } | null {
  if (!bounds || bounds.error) return null;
  const left = bounds.leftEdge;
  const right = bounds.rightEdge;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 2 || right.length < 2) return null;
  return { left, right };
}

function buildGeometry(telemetry: TelemetryPacket[], sectorTimes: SectorTimes | null, edges: { left: Pt[]; right: Pt[] } | null): Geometry | null {
  if (telemetry.length < 10) return null;

  // Downsample the driven line; keep each point's original telemetry index so
  // hover can look up the real frame. Remap sector split indices to the reduced set.
  const step = Math.max(1, Math.floor(telemetry.length / TARGET_POINTS));
  const line: { p: Pt; idx: number }[] = [];
  for (let i = 0; i < telemetry.length; i += step) line.push({ p: { x: telemetry[i].PositionX, z: telemetry[i].PositionZ }, idx: i });
  const rawS1 = sectorTimes && sectorTimes.s1Idx > 0 ? Math.floor(sectorTimes.s1Idx / step) : Math.floor(line.length / 3);
  const rawS2 = sectorTimes && sectorTimes.s2Idx > 0 ? Math.floor(sectorTimes.s2Idx / step) : Math.floor((2 * line.length) / 3);

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const acc = (p: Pt) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  };
  for (const l of line) acc(l.p);
  if (edges) {
    for (const p of edges.left) acc(p);
    for (const p of edges.right) acc(p);
  }

  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const span = Math.max(spanX, spanZ);
  if (!(span > 0)) return null;

  const scale = (VIEW - PAD * 2) / span;
  const offX = (VIEW - spanX * scale) / 2;
  const offZ = (VIEW - spanZ * scale) / 2;
  const px = (p: Pt) => offX + (p.x - minX) * scale;
  // Flip Z so the map isn't drawn upside-down relative to screen space.
  const py = (p: Pt) => VIEW - (offZ + (p.z - minZ) * scale);
  const str = (p: Pt) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`;
  const polyline = (ps: Pt[]) => ps.map(str).join(" ");

  const projPts: ProjPt[] = line.map((l) => ({ x: px(l.p), y: py(l.p), idx: l.idx }));
  const pline = line.map((l) => l.p);

  const n = line.length;
  const s1 = Math.min(Math.max(rawS1, 1), n - 2);
  const s2 = Math.min(Math.max(rawS2, s1 + 1), n - 1);

  return {
    allPoints: polyline(pline),
    segments: [polyline(pline.slice(0, s1 + 1)), polyline(pline.slice(s1, s2 + 1)), polyline(pline.slice(s2))],
    leftEdge: edges ? polyline(edges.left) : null,
    rightEdge: edges ? polyline(edges.right) : null,
    pts: projPts,
  };
}
