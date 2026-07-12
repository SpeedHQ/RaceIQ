import { useEffect, useState, useRef } from "react";
import { useGameId } from "@/stores/game";
import { client } from "@/lib/rpc";
import { CurbDebugSection } from "./CurbDebugSection";
import type { Point, TrackBoundaries, TrackCurb, TrackSectors } from "../types";

/**
 * TrackDebugPanel — Full-page debug visualization for track boundary data.
 * Shows outline + boundaries on a large canvas with drag/zoom and diagnostic info sidebar.
 */
export function TrackDebugPanel({
  trackOrdinal,
  outline,
  flipX = false,
  displaySectors,
  sectorBounds,
  editingSegments,
  editingSectors,
  trackLengthKm,
  trackCreatedAt,
  corners,
  straights,
}: {
  trackOrdinal: number;
  outline: Point[] | null;
  flipX?: boolean;
  displaySectors?: TrackSectors | null;
  sectorBounds?: { s1End: number; s2End: number } | null;
  editingSegments?: boolean;
  editingSectors?: boolean;
  trackLengthKm?: number;
  trackCreatedAt?: string;
  corners?: number;
  straights?: number;
}) {
  const [overlayMode, setOverlayMode] = useState<"segments" | "sectors">("segments");

  useEffect(() => {
    if (editingSegments) setOverlayMode("segments");
    else if (editingSectors) setOverlayMode("sectors");
  }, [editingSegments, editingSectors]);
  const gid = useGameId() ?? undefined;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [boundaries, setBoundaries] = useState<TrackBoundaries | null>(null);
  const [curbs, setCurbs] = useState<TrackCurb[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, z: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, z: 0 });
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);
  const dragging = useRef<{ startX: number; startY: number; startPanX: number; startPanZ: number } | null>(null);

  useEffect(() => {
    if (!gid) return;
    setLoading(true);
    Promise.all([
      client.api["track-boundaries"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid ?? undefined } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackBoundaries) : null))
        .catch(() => null),
      client.api["track-curbs"][":ordinal"]
        .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gid ?? undefined } })
        .then((r) => (r.ok ? (r.json() as unknown as TrackCurb[]) : null))
        .catch(() => null),
    ]).then(([b, c]) => {
      setBoundaries(b);
      setCurbs(c);
      setLoading(false);
    });
  }, [trackOrdinal, gid]);

  // Scroll-to-zoom (cursor-centered)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;
      const factor = Math.pow(0.999, e.deltaY);
      const newZoom = Math.min(Math.max(currentZoom * factor, 0.5), 8);
      if (Math.abs(newZoom - currentZoom) < 0.001) return;

      if (newZoom <= 0.51) {
        setZoom(1);
        setPan({ x: 0, z: 0 });
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const ratio = newZoom / currentZoom;
      setZoom(newZoom);
      setPan({
        x: mouseX - cx - (mouseX - cx - currentPan.x) * ratio,
        z: mouseY - cy - (mouseY - cy - currentPan.z) * ratio,
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // Draw debug canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !outline || outline.length < 2) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Compute bounding box including boundaries
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    const allPts: Point[][] = [outline];
    if (boundaries) {
      allPts.push(boundaries.leftEdge, boundaries.rightEdge);
    }
    for (const pts of allPts) {
      for (const p of pts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }

    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;
    const padding = 20;
    const baseScale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeZ);
    const scale = baseScale * zoom;
    const offsetX = (w - rangeX * scale) / 2 + pan.x;
    const offsetZ = (h - rangeZ * scale) / 2 + pan.z;

    function toCanvas(x: number, z: number): [number, number] {
      return [flipX ? offsetX + (x - minX) * scale : offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
    }

    // Draw boundary fill (hidden when editing segments/sectors)
    const leftEdge = boundaries?.leftEdge;
    const rightEdge = boundaries?.rightEdge;
    if (!editingSegments && !editingSectors && leftEdge && rightEdge && leftEdge.length > 2 && rightEdge.length > 2) {
      ctx.beginPath();
      const [lx0, ly0] = toCanvas(leftEdge[0].x, leftEdge[0].z);
      ctx.moveTo(lx0, ly0);
      for (let i = 1; i < leftEdge.length; i++) {
        const [lx, ly] = toCanvas(leftEdge[i].x, leftEdge[i].z);
        ctx.lineTo(lx, ly);
      }
      for (let i = rightEdge.length - 1; i >= 0; i--) {
        const [rx, ry] = toCanvas(rightEdge[i].x, rightEdge[i].z);
        ctx.lineTo(rx, ry);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(51, 65, 85, 0.3)";
      ctx.fill();

      // Edge lines — color each edge span by the segment it belongs to.
      const SEG_COLORS = ["#f87171", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#f472b6", "#2dd4bf", "#fb923c"];
      const segList = overlayMode === "segments" && displaySectors?.segments.length ? displaySectors.segments : null;
      const drawEdge = (edge: Point[]) => {
        if (!segList) {
          ctx.beginPath();
          const [ex0, ey0] = toCanvas(edge[0].x, edge[0].z);
          ctx.moveTo(ex0, ey0);
          for (let i = 1; i < edge.length; i++) {
            const [ex, ey] = toCanvas(edge[i].x, edge[i].z);
            ctx.lineTo(ex, ey);
          }
          ctx.strokeStyle = "#64748b";
          ctx.lineWidth = 1.5;
          ctx.stroke();
          return;
        }
        const en = edge.length;
        for (let s = 0; s < segList.length; s++) {
          const seg = segList[s];
          const startI = Math.max(0, Math.floor(seg.startFrac * en));
          const endI = Math.min(en - 1, Math.ceil(seg.endFrac * en));
          if (startI >= endI) continue;
          ctx.beginPath();
          const [ex0, ey0] = toCanvas(edge[startI].x, edge[startI].z);
          ctx.moveTo(ex0, ey0);
          for (let i = startI + 1; i <= endI; i++) {
            const [ex, ey] = toCanvas(edge[i].x, edge[i].z);
            ctx.lineTo(ex, ey);
          }
          ctx.strokeStyle = SEG_COLORS[s % SEG_COLORS.length];
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      };
      ctx.globalAlpha = 0.85;
      drawEdge(leftEdge);
      drawEdge(rightEdge);
      ctx.globalAlpha = 1;

      // Pit lane
      if (boundaries.pitLane && boundaries.pitLane.length > 1) {
        ctx.beginPath();
        const [px0, py0] = toCanvas(boundaries.pitLane[0].x, boundaries.pitLane[0].z);
        ctx.moveTo(px0, py0);
        for (let i = 1; i < boundaries.pitLane.length; i++) {
          const [px, py] = toCanvas(boundaries.pitLane[i].x, boundaries.pitLane[i].z);
          ctx.lineTo(px, py);
        }
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Geometric centerline: midpoint of left/right edges per index when
    // boundaries are available. Falls back to the recorded API outline.
    const geoCenter: Point[] = (() => {
      if (!leftEdge?.length || !rightEdge?.length) return outline;
      const m = Math.min(leftEdge.length, rightEdge.length);
      const pts: Point[] = new Array(m);
      for (let i = 0; i < m; i++) {
        pts[i] = { x: (leftEdge[i].x + rightEdge[i].x) / 2, z: (leftEdge[i].z + rightEdge[i].z) / 2 };
      }
      return pts;
    })();
    const centerPts = geoCenter;
    const [sx, sy] = toCanvas(centerPts[0].x, centerPts[0].z);
    // Skip the centerline draw when track edges are visible — the edges already
    // define the corridor and the segment overlays sit on top.
    if (!boundaries?.leftEdge?.length || !boundaries?.rightEdge?.length) {
      ctx.beginPath();
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.moveTo(sx, sy);
      for (let i = 1; i < centerPts.length; i++) {
        const [px, py] = toCanvas(centerPts[i].x, centerPts[i].z);
        ctx.lineTo(px, py);
      }
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }

    // Draw segment or sector overlays — use geoCenter for visual alignment.
    if (overlayMode === "segments" && displaySectors && displaySectors.segments.length > 0) {
      const n = centerPts.length;
      for (const seg of displaySectors.segments) {
        const start = Math.floor(seg.startFrac * n);
        const end = Math.min(Math.ceil(seg.endFrac * n), n - 1);
        if (start >= end) continue;
        // Continuous colored stroke only while editing — otherwise ticks + labels alone.
        if (editingSegments) {
          ctx.beginPath();
          const [segX0, segY0] = toCanvas(centerPts[start].x, centerPts[start].z);
          ctx.moveTo(segX0, segY0);
          for (let i = start + 1; i <= end; i++) {
            const [px, py] = toCanvas(centerPts[i].x, centerPts[i].z);
            ctx.lineTo(px, py);
          }
          ctx.strokeStyle = seg.type === "corner" ? "rgba(239,68,68,0.7)" : "rgba(59,130,246,0.6)";
          ctx.lineWidth = 4;
          ctx.globalAlpha = 0.8;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // Label at midpoint
        const mid = Math.floor((start + end) / 2);
        const [lx, ly] = toCanvas(centerPts[mid].x, centerPts[mid].z);
        const label = seg.name || (seg.type === "corner" ? "T" : "S");
        ctx.font = "bold 10px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(lx - ctx.measureText(label).width / 2 - 2, ly - 7, ctx.measureText(label).width + 4, 14);
        ctx.fillStyle = seg.type === "corner" ? "#fca5a5" : "#93c5fd";
        ctx.fillText(label, lx, ly);
      }
      // Draw perpendicular separator ticks at every segment boundary
      const TICK_HALF = 12;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.setLineDash([3, 2]);
      for (const seg of displaySectors.segments) {
        const idx = Math.floor(seg.startFrac * n);
        const a = (idx - 1 + n) % n;
        const b = (idx + 1) % n;
        const [tx, ty] = toCanvas(centerPts[idx].x, centerPts[idx].z);
        const [ax, ay] = toCanvas(centerPts[a].x, centerPts[a].z);
        const [bx, by] = toCanvas(centerPts[b].x, centerPts[b].z);
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        // Perpendicular = (-dy, dx) / len
        const px = -dy / len;
        const py = dx / len;
        ctx.beginPath();
        ctx.moveTo(tx - px * TICK_HALF, ty - py * TICK_HALF);
        ctx.lineTo(tx + px * TICK_HALF, ty + py * TICK_HALF);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineWidth = 2.5;
    } else if (overlayMode === "sectors" && sectorBounds) {
      const n = centerPts.length;
      const s1 = Math.floor(sectorBounds.s1End * n);
      const s2 = Math.floor(sectorBounds.s2End * n);
      const sectorDefs = [
        { from: 0, to: s1, color: "rgba(239,68,68,0.7)" },
        { from: s1, to: s2, color: "rgba(59,130,246,0.6)" },
        { from: s2, to: n - 1, color: "rgba(234,179,8,0.6)" },
      ];
      for (const { from, to, color } of sectorDefs) {
        if (from >= to) continue;
        ctx.beginPath();
        const [sx0, sy0] = toCanvas(centerPts[from].x, centerPts[from].z);
        ctx.moveTo(sx0, sy0);
        for (let i = from + 1; i <= to; i++) {
          const [px, py] = toCanvas(centerPts[i].x, centerPts[i].z);
          ctx.lineTo(px, py);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.8;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = 2.5;
    }

    // Draw curbs as dots
    if (curbs && curbs.length > 0) {
      for (const seg of curbs) {
        const color = seg.side === "left" ? "#ef4444" : seg.side === "right" ? "#f97316" : "#eab308";
        for (const pt of seg.points) {
          const [cx, cy] = toCanvas(pt.x, pt.z);
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.8;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Start/finish marker
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#10b981";
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Legend
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    const legendY = h - 10;
    ctx.fillStyle = "#94a3b8";
    ctx.fillRect(10, legendY - 5, 14, 2);
    ctx.fillText("Center", 28, legendY);
    if (boundaries) {
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(82, legendY - 5, 14, 2);
      ctx.fillText("Left edge", 100, legendY);
      ctx.fillStyle = "#3b82f6";
      ctx.fillRect(172, legendY - 5, 14, 2);
      ctx.fillText("Right edge", 190, legendY);
    }
    if (curbs && curbs.length > 0) {
      ctx.fillStyle = "#f97316";
      ctx.fillRect(272, legendY - 5, 14, 2);
      ctx.fillText("Curbs", 290, legendY);
    }
    if (boundaries?.pitLane) {
      ctx.fillStyle = "#22d3ee";
      ctx.fillRect(340, legendY - 5, 14, 2);
      ctx.fillText("Pit lane", 358, legendY);
    }
  }, [outline, boundaries, curbs, zoom, pan, flipX, displaySectors, sectorBounds, overlayMode, editingSegments, editingSectors]);

  if (loading) {
    return <div className="text-app-subtext text-app-text-dim py-8 text-center">Loading debug data...</div>;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 h-[calc(100vh-160px)]">
      {/* Canvas */}
      <div className="bg-app-bg rounded-lg border border-app-border relative min-h-0">
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-grab active:cursor-grabbing"
          onMouseDown={(e) => {
            dragging.current = { startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanZ: pan.z };
          }}
          onMouseMove={(e) => {
            if (!dragging.current) return;
            const dx = e.clientX - dragging.current.startX;
            const dy = e.clientY - dragging.current.startY;
            setPan({ x: dragging.current.startPanX + dx, z: dragging.current.startPanZ + dy });
          }}
          onMouseUp={() => {
            dragging.current = null;
          }}
          onMouseLeave={() => {
            dragging.current = null;
          }}
        />
        {/* Zoom controls */}
        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button
            onClick={() => setZoom((z) => Math.min(z + 0.25, 8))}
            className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
          >
            +
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
            className="w-7 h-7 text-app-body bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
          >
            -
          </button>
          {zoom !== 1 && (
            <button
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, z: 0 });
              }}
              className="w-7 h-7 text-app-unit bg-app-surface-alt/80 border border-app-border-input text-app-text-secondary hover:text-app-text rounded flex items-center justify-center"
            >
              {zoom % 1 === 0 ? `${zoom}x` : zoom.toFixed(1) + "x"}
            </button>
          )}
          {(displaySectors || sectorBounds) && (
            <>
              <div className="h-px" />
              <button
                onClick={() => setOverlayMode((m) => (m === "segments" ? "sectors" : "segments"))}
                className={`px-1.5 py-1 text-[9px] font-mono rounded border transition-colors ${
                  overlayMode === "sectors" ? "bg-amber-900/50 border-amber-700 text-amber-400" : "bg-app-surface-alt/80 border-app-border-input text-app-text-secondary hover:text-app-text"
                }`}
              >
                {overlayMode === "sectors" ? "Sectors" : "Segments"}
              </button>
            </>
          )}
        </div>
        {(trackLengthKm || corners || straights || trackCreatedAt) && (
          <div className="absolute bottom-2 left-2 flex items-center gap-2.5 text-[10px] font-mono text-app-text-dim bg-app-surface/70 backdrop-blur-sm rounded px-2 py-1 pointer-events-none">
            {(trackLengthKm ?? 0) > 0 && <span>{trackLengthKm} km</span>}
            {(corners ?? 0) > 0 && (
              <>
                <span className="text-app-text-dim/40">·</span>
                <span>{corners} corners</span>
              </>
            )}
            {(straights ?? 0) > 0 && (
              <>
                <span className="text-app-text-dim/40">·</span>
                <span>{straights} straights</span>
              </>
            )}
            {trackCreatedAt && (
              <>
                <span className="text-app-text-dim/40">·</span>
                <span>{new Date(trackCreatedAt).toLocaleDateString()}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Info sidebar */}
      <div className="flex flex-col gap-3 overflow-auto">
        <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Outline</div>
          <div className="space-y-1 text-app-body">
            <div className="flex justify-between">
              <span className="text-app-text-muted">Points</span>
              <span className="font-mono text-app-text">{outline?.length ?? 0}</span>
            </div>
          </div>
        </div>

        <div className="bg-app-surface/50 rounded-lg border border-app-border p-3">
          <div className="text-app-label text-app-text-muted uppercase tracking-wider mb-2">Boundaries</div>
          <div className="space-y-1 text-app-body">
            <div className="flex justify-between">
              <span className="text-app-text-muted">Available</span>
              <span className={`font-mono ${boundaries ? "text-green-400" : "text-red-400"}`}>{boundaries ? "Yes" : "No"}</span>
            </div>
            {boundaries && (
              <>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Left edge pts</span>
                  <span className="font-mono text-app-text">{boundaries.leftEdge.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Right edge pts</span>
                  <span className="font-mono text-app-text">{boundaries.rightEdge.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Coord system</span>
                  <span className="font-mono text-app-text">{boundaries.coordSystem}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Pit lane</span>
                  <span className={`font-mono ${boundaries.pitLane ? "text-green-400" : "text-app-text-dim"}`}>{boundaries.pitLane ? `${boundaries.pitLane.length} pts` : "None"}</span>
                </div>
              </>
            )}
          </div>
        </div>

        <CurbDebugSection trackOrdinal={trackOrdinal} curbs={curbs} setCurbs={setCurbs} setBoundaries={setBoundaries} />
      </div>
    </div>
  );
}
