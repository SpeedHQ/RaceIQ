import type { TelemetryPacket, TuneIssue } from "@shared/types";
import { useMemo, useRef } from "react";
import type { TrackCorner } from "../../../hooks/queries";
import { buildGeometry, type Pt, projectPoint, type SectorTimesLite, VIEW } from "../track-map-geometry";

interface TrackFocusMapProps {
  telemetry: TelemetryPacket[] | null;
  sectorTimes: SectorTimesLite | null;
  edges: { left: Pt[]; right: Pt[] } | null;
  corners: TrackCorner[];
  issues: TuneIssue[];
  cursorFrac: number | null;
  onCursorFrac: (f: number | null) => void;
}

const SEV_COLOR: Record<string, string> = {
  critical: "var(--color-dynamics-red, #ef4444)",
  warn: "var(--color-dynamics-amber, #f59e0b)",
  info: "#38bdf8",
};

function clampSteer(raw: number): number {
  return Math.max(-1, Math.min(1, raw / 128));
}

/**
 * Focus-lap track map: driven line (3 sector-colored segments), optional
 * track edges, corner markers, issue dots (severity-colored, critical gets a
 * halo), a cursor dot synced to `cursorFrac`, and a 4-cell Speed/Throttle/
 * Brake/Steer readout below the map that tracks the cursor (or the lap
 * average when no cursor is set).
 */
export function TrackFocusMap({ telemetry, sectorTimes, edges, corners, issues, cursorFrac, onCursorFrac }: TrackFocusMapProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const geometry = useMemo(() => (telemetry ? buildGeometry(telemetry, sectorTimes, edges) : null), [telemetry, sectorTimes, edges]);

  const totalDist = useMemo(() => {
    if (!telemetry || telemetry.length < 2) return 0;
    return telemetry[telemetry.length - 1].DistanceTraveled - telemetry[0].DistanceTraveled;
  }, [telemetry]);

  function fracToPoint(frac: number): { x: number; y: number } | null {
    if (!telemetry || telemetry.length === 0) return null;
    const idx = Math.max(0, Math.min(telemetry.length - 1, Math.round(frac * (telemetry.length - 1))));
    const t = telemetry[idx];
    return projectPoint({ x: t.PositionX, z: t.PositionZ }, telemetry, edges);
  }

  function distanceToFrac(distance: number): number | null {
    if (!telemetry || telemetry.length < 2 || totalDist <= 0) return null;
    return Math.max(0, Math.min(1, (distance - telemetry[0].DistanceTraveled) / totalDist));
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!geometry || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * VIEW;
    const my = ((e.clientY - rect.top) / rect.height) * VIEW;
    let best = geometry.pts[0];
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of geometry.pts) {
      const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best && telemetry) onCursorFrac(best.idx / (telemetry.length - 1));
  }

  const cursorIdx = cursorFrac != null && telemetry ? Math.round(cursorFrac * (telemetry.length - 1)) : null;
  const cursorPt = cursorFrac != null ? fracToPoint(cursorFrac) : null;
  const readoutFrame = cursorIdx != null && telemetry ? telemetry[cursorIdx] : null;

  return (
    <div className="space-y-2">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          width="100%"
          height="100%"
          className="aspect-square"
          style={{ cursor: geometry ? "crosshair" : "default" }}
          onMouseMove={onMove}
          onMouseLeave={() => onCursorFrac(null)}
        >
          {!geometry && (
            <text x={VIEW / 2} y={VIEW / 2} textAnchor="middle" fontSize={10} fill="var(--color-app-text-dim, #7a8ea0)">
              No telemetry
            </text>
          )}
          {geometry?.leftEdge && <polyline points={geometry.leftEdge} fill="none" stroke="var(--color-app-border, #2a2a2a)" strokeWidth={1} />}
          {geometry?.rightEdge && <polyline points={geometry.rightEdge} fill="none" stroke="var(--color-app-border, #2a2a2a)" strokeWidth={1} />}
          {(["s1", "s2", "s3"] as const).map((segKey, i) => (
            <polyline key={segKey} points={geometry?.segments[i]} fill="none" stroke={["#f87171", "#60a5fa", "#facc15"][i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {corners.map((c) => {
            const frac = distanceToFrac(c.distanceStart);
            const pt = frac != null ? fracToPoint(frac) : null;
            if (!pt) return null;
            return (
              <g key={c.index}>
                <circle cx={pt.x} cy={pt.y} r={2.5} fill="var(--color-app-text-dim, #7a8ea0)" stroke="#020617" strokeWidth={0.75} />
                <text x={pt.x + 4} y={pt.y - 4} fontSize={7} fill="var(--color-app-text-dim, #7a8ea0)">
                  {c.label}
                </text>
              </g>
            );
          })}
          {issues.map((it) => {
            if (it.distanceFrac == null) return null;
            const pt = fracToPoint(it.distanceFrac);
            if (!pt) return null;
            const color = SEV_COLOR[it.severity] ?? SEV_COLOR.info;
            return (
              <g key={`${it.kind}-${it.corner ?? ""}-${it.distanceFrac}-${it.detail}`}>
                {it.severity === "critical" && <circle cx={pt.x} cy={pt.y} r={6} fill={color} opacity={0.25} />}
                <circle cx={pt.x} cy={pt.y} r={3} fill={color} stroke="#020617" strokeWidth={1} />
              </g>
            );
          })}
          {cursorPt && <circle cx={cursorPt.x} cy={cursorPt.y} r={4} fill="var(--color-app-accent, #22d3ee)" stroke="#020617" strokeWidth={1.2} />}
        </svg>
        {cursorFrac != null && (
          <div className="absolute top-1 right-1 text-[10px] font-mono tabular-nums bg-app-surface/80 border border-app-border rounded px-1.5 py-0.5 text-app-text-muted">
            {(cursorFrac * 100).toFixed(1)}% lap
          </div>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1.5 text-center">
        {[
          { label: "Speed", value: readoutFrame ? `${(readoutFrame.Speed * 3.6).toFixed(0)}` : "—", unit: "km/h" },
          { label: "Throttle", value: readoutFrame ? `${((readoutFrame.Accel / 255) * 100).toFixed(0)}` : "—", unit: "%" },
          { label: "Brake", value: readoutFrame ? `${((readoutFrame.Brake / 255) * 100).toFixed(0)}` : "—", unit: "%" },
          { label: "Steer", value: readoutFrame ? `${(clampSteer(readoutFrame.Steer) * 100).toFixed(0)}` : "—", unit: "%" },
        ].map((cell) => (
          <div key={cell.label} className="rounded bg-app-surface border border-app-border py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-app-text-dim">{cell.label}</div>
            <div className="text-sm font-mono tabular-nums text-app-text">
              {cell.value}
              <span className="text-[9px] text-app-text-dim ml-0.5">{cell.unit}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-app-text-dim">
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "#f87171" }} /> S1
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "#60a5fa" }} /> S2
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-1 rounded-sm inline-block" style={{ background: "#facc15" }} /> S3
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: SEV_COLOR.critical }} /> critical
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: SEV_COLOR.warn }} /> warn
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: SEV_COLOR.info }} /> info
        </span>
      </div>
    </div>
  );
}
