import { useEffect, useState, useRef, useCallback } from "react";

interface TrackInfo {
  ordinal: number;
  name: string;
  location: string;
  country: string;
  variant: string;
  lengthKm: number;
  hasOutline: boolean;
}

interface Point {
  x: number;
  z: number;
}

interface TrackSegment {
  type: "corner" | "straight";
  name: string;
  startFrac: number;
  endFrac: number;
  startIdx: number;
  endIdx: number;
}

interface TrackSectors {
  segments: TrackSegment[];
  totalDist: number;
}

/** TrackCard — Gallery thumbnail: fetches outline by ordinal and renders a small static track map. */
function TrackCard({ track, onSelect }: { track: TrackInfo; onSelect: (t: TrackInfo) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);

  useEffect(() => {
    if (!track.hasOutline) return;
    fetch(`/api/track-outline/${track.ordinal}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.points && Array.isArray(data.points)) setOutline(data.points);
        else if (Array.isArray(data)) setOutline(data);
        else setOutline(null);
      })
      .catch(() => {});
  }, [track.ordinal, track.hasOutline]);

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, false, null);
  }, [outline]);

  return (
    <div
      className="border border-slate-800 rounded-lg overflow-hidden cursor-pointer transition-all bg-slate-900/50 hover:border-slate-700 hover:bg-slate-800/50"
      onClick={() => onSelect(track)}
    >
      <div className="p-3">
        <div className="text-sm font-medium text-white">{track.name}</div>
        <div className="text-xs text-slate-500">
          {track.variant} &middot; {track.location}, {track.country.toUpperCase()}
          {track.lengthKm > 0 && ` &middot; ${track.lengthKm} km`}
        </div>
      </div>
      <div className="bg-slate-950" style={{ height: 150 }}>
        {track.hasOutline ? (
          <canvas ref={canvasRef} className="w-full h-full" />
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-slate-600">
            No outline available
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * TrackDetail — Full-size track view with segment overlay and stats sidebar.
 * Fetches both outline and sector data; segments are color-coded (red=corner, blue=straight).
 */
function TrackDetail({ track, onBack }: { track: TrackInfo; onBack: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [sectors, setSectors] = useState<TrackSectors | null>(null);

  useEffect(() => {
    if (!track.hasOutline) return;
    Promise.all([
      fetch(`/api/track-outline/${track.ordinal}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/track-sectors/${track.ordinal}`).then((r) => (r.ok ? r.json() : null)),
    ]).then(([outlineData, sectorData]) => {
      if (outlineData?.points && Array.isArray(outlineData.points)) setOutline(outlineData.points);
      else if (Array.isArray(outlineData)) setOutline(outlineData);
      else setOutline(null);
      setSectors(sectorData);
    }).catch(() => {});
  }, [track.ordinal, track.hasOutline]);

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, true, sectors);
  }, [outline, sectors]);

  const corners = sectors?.segments.filter((s) => s.type === "corner") ?? [];
  const straights = sectors?.segments.filter((s) => s.type === "straight") ?? [];

  return (
    <div className="p-4 overflow-auto h-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 transition-colors"
        >
          &larr; Back
        </button>
        <div>
          <div className="text-lg font-semibold text-white">{track.name}</div>
          <div className="text-xs text-slate-500">
            {track.variant} &middot; {track.location}, {track.country.toUpperCase()}
            {track.lengthKm > 0 && ` &middot; ${track.lengthKm} km`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        {/* Large track map */}
        <div className="bg-slate-950 rounded-lg border border-slate-800" style={{ height: 400 }}>
          {track.hasOutline ? (
            <canvas ref={canvasRef} className="w-full h-full" />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-slate-600">
              No outline available
            </div>
          )}
        </div>

        {/* Track info sidebar */}
        <div className="flex flex-col gap-3">
          {/* Stats */}
          <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-3">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Track Info</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-slate-500 text-xs">Length</span>
                <div className="font-mono text-white">{track.lengthKm > 0 ? `${track.lengthKm} km` : "—"}</div>
              </div>
              <div>
                <span className="text-slate-500 text-xs">Corners</span>
                <div className="font-mono text-white">{corners.length}</div>
              </div>
              <div>
                <span className="text-slate-500 text-xs">Straights</span>
                <div className="font-mono text-white">{straights.length}</div>
              </div>
              <div>
                <span className="text-slate-500 text-xs">Segments</span>
                <div className="font-mono text-white">{sectors?.segments.length ?? 0}</div>
              </div>
            </div>
          </div>

          {/* Segment list */}
          {sectors && sectors.segments.length > 0 && (
            <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-3">
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Segments</div>
              <div className="flex flex-col gap-1 max-h-[250px] overflow-auto">
                {sectors.segments.map((seg, i) => {
                  const pct = ((seg.endFrac - seg.startFrac) * 100).toFixed(1);
                  const color = seg.type === "corner" ? "text-red-400" : "text-blue-400";
                  const bg = seg.type === "corner" ? "bg-red-500/10" : "bg-blue-500/10";
                  return (
                    <div key={i} className={`flex items-center justify-between px-2 py-1 rounded ${bg}`}>
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-mono font-bold ${color}`}>{seg.name}</span>
                        <span className="text-[10px] text-slate-500 capitalize">{seg.type}</span>
                      </div>
                      <span className="text-[10px] font-mono text-slate-400">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * drawTrack — Shared canvas rendering for both gallery thumbnails and detail views.
 * Draws a thick base outline, then overlays color-coded segments (corner/straight).
 * Segment labels are offset perpendicular to the track direction so they don't overlap the line.
 * The perpendicular offset is computed from neighboring outline points' tangent vector.
 */
function drawTrack(canvas: HTMLCanvasElement, outline: Point[], large: boolean, sectors?: TrackSectors | null) {
  const ctx = canvas.getContext("2d");
  if (!ctx || outline.length < 2) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const rangeX = (maxX - minX) || 1;
  const rangeZ = (maxZ - minZ) || 1;
  const padding = large ? 20 : 12;
  const scale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeZ);
  const offsetX = (w - rangeX * scale) / 2;
  const offsetZ = (h - rangeZ * scale) / 2;

  function toCanvas(x: number, z: number): [number, number] {
    return [offsetX + (x - minX) * scale, offsetZ + (z - minZ) * scale];
  }

  // Track outline
  ctx.beginPath();
  ctx.strokeStyle = large ? "#475569" : "#334155";
  ctx.lineWidth = large ? 4 : 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
  ctx.moveTo(sx, sy);
  for (let i = 1; i < outline.length; i++) {
    const [px, py] = toCanvas(outline[i].x, outline[i].z);
    ctx.lineTo(px, py);
  }
  ctx.lineTo(sx, sy);
  ctx.stroke();

  // Inner line — color-coded by segment type. startFrac/endFrac map [0,1] to outline indices.
  if (sectors && sectors.segments.length > 0) {
    const n = outline.length;
    for (const seg of sectors.segments) {
      const start = Math.round(seg.startFrac * n);
      const end = Math.min(Math.round(seg.endFrac * n), n - 1);
      const color = seg.type === "corner" ? "#ef4444" : "#3b82f6";

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = large ? 0.8 : 0.5;
      ctx.lineWidth = large ? 2 : 1.5;
      const [fx, fy] = toCanvas(outline[start].x, outline[start].z);
      ctx.moveTo(fx, fy);
      for (let i = start + 1; i <= end; i++) {
        const [px, py] = toCanvas(outline[i].x, outline[i].z);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Label at midpoint of segment
      if (large || seg.type === "corner") {
        const midIdx = Math.round((start + end) / 2);
        const midPt = outline[Math.min(midIdx, n - 1)];
        const [mx, my] = toCanvas(midPt.x, midPt.z);

        // Offset label away from track using perpendicular
        const prevIdx = Math.max(0, midIdx - 2);
        const nextIdx = Math.min(n - 1, midIdx + 2);
        const dx = outline[nextIdx].x - outline[prevIdx].x;
        const dz = outline[nextIdx].z - outline[prevIdx].z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const offDist = large ? 14 : 8;
        const lx = mx + (-dz / len) * offDist;
        const ly = my + (dx / len) * offDist;

        ctx.font = large ? "bold 9px monospace" : "bold 7px monospace";
        ctx.fillStyle = color;
        ctx.globalAlpha = large ? 0.9 : 0.7;
        ctx.textAlign = "center";
        ctx.fillText(seg.name, lx, ly + 3);
        ctx.globalAlpha = 1;
      }
    }
  } else {
    ctx.beginPath();
    ctx.strokeStyle = large ? "#94a3b8" : "#64748b";
    ctx.lineWidth = large ? 2 : 1.5;
    ctx.moveTo(sx, sy);
    for (let i = 1; i < outline.length; i++) {
      const [px, py] = toCanvas(outline[i].x, outline[i].z);
      ctx.lineTo(px, py);
    }
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }

  // Start marker
  ctx.beginPath();
  ctx.arc(sx, sy, large ? 5 : 3, 0, Math.PI * 2);
  ctx.fillStyle = "#10b981";
  ctx.fill();

  // Direction arrow from start point along first ~5% of outline
  const arrowIdx = Math.min(Math.floor(outline.length * 0.05), outline.length - 1);
  if (arrowIdx > 0) {
    const [ax, ay] = toCanvas(outline[arrowIdx].x, outline[arrowIdx].z);
    const dx = ax - sx;
    const dy = ay - sy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 3) {
      const nx = dx / len;
      const ny = dy / len;
      const arrowLen = large ? 18 : 12;
      const wingLen = large ? 5 : 3;
      const tipX = sx + nx * arrowLen;
      const tipY = sy + ny * arrowLen;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = large ? 2 : 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - nx * wingLen * 2 + ny * wingLen, tipY - ny * wingLen * 2 - nx * wingLen);
      ctx.lineTo(tipX - nx * wingLen * 2 - ny * wingLen, tipY - ny * wingLen * 2 + nx * wingLen);
      ctx.closePath();
      ctx.fillStyle = "#10b981";
      ctx.fill();
    }
  }
}

/** TrackViewer — Gallery view of all known tracks, split into "with outlines" and "without". */
export function TrackViewer() {
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrack, setSelectedTrack] = useState<TrackInfo | null>(null);

  useEffect(() => {
    fetch("/api/tracks")
      .then((r) => r.json())
      .then(setTracks)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-4 text-slate-600">Loading tracks...</div>;
  }

  if (selectedTrack) {
    return <TrackDetail track={selectedTrack} onBack={() => setSelectedTrack(null)} />;
  }

  const withOutline = tracks.filter((t) => t.hasOutline);
  const withoutOutline = tracks.filter((t) => !t.hasOutline);

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">
        Available Tracks ({withOutline.length} with outlines, {withoutOutline.length} without)
      </div>

      {withOutline.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {withOutline.map((t) => (
            <TrackCard key={t.ordinal} track={t} onSelect={setSelectedTrack} />
          ))}
        </div>
      )}

      {withoutOutline.length > 0 && (
        <>
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-3 mt-4">
            Tracks Without Outlines
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {withoutOutline.map((t) => (
              <div
                key={t.ordinal}
                className="border border-slate-800 rounded-lg p-3 bg-slate-900/30 cursor-pointer hover:border-slate-700"
                onClick={() => setSelectedTrack(t)}
              >
                <div className="text-sm text-slate-400">{t.name}</div>
                <div className="text-xs text-slate-600">
                  {t.variant} &middot; {t.location}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
