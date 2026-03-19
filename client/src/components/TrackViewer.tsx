import { useEffect, useState, useRef, useCallback } from "react";
import { useSearch, useNavigate } from "@tanstack/react-router";

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
  const [zoom, setZoom] = useState(1);
  const [editing, setEditing] = useState(false);
  const [editSegments, setEditSegments] = useState<TrackSegment[]>([]);
  const [saving, setSaving] = useState(false);

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

  // Use edit segments for preview when editing, otherwise use fetched sectors
  const displaySectors = editing && editSegments.length > 0
    ? { segments: editSegments, totalDist: sectors?.totalDist ?? 0 }
    : sectors;

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, true, displaySectors, zoom);
  }, [outline, displaySectors, zoom]);

  const startEditing = useCallback(() => {
    if (sectors?.segments) {
      setEditSegments(sectors.segments.map((s) => ({ ...s })));
      setEditing(true);
    }
  }, [sectors]);

  const updateSegFrac = useCallback((idx: number, field: "startFrac" | "endFrac", value: number) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx][field] = value;
      // Auto-chain: if changing endFrac, update next segment's startFrac
      if (field === "endFrac" && idx + 1 < next.length) {
        next[idx + 1].startFrac = value;
      }
      // Auto-chain: if changing startFrac, update prev segment's endFrac
      if (field === "startFrac" && idx > 0) {
        next[idx - 1].endFrac = value;
      }
      return next;
    });
  }, []);

  const updateSegName = useCallback((idx: number, name: string) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx].name = name;
      return next;
    });
  }, []);

  const toggleSegType = useCallback((idx: number) => {
    setEditSegments((prev) => {
      const next = prev.map((s) => ({ ...s }));
      next[idx].type = next[idx].type === "corner" ? "straight" : "corner";
      return next;
    });
  }, []);

  const addSegment = useCallback((afterIdx: number) => {
    setEditSegments((prev) => {
      const next = [...prev];
      const current = next[afterIdx];
      const midFrac = (current.startFrac + current.endFrac) / 2;
      // Split current segment at midpoint
      const newSeg: TrackSegment = {
        type: current.type === "corner" ? "straight" : "corner",
        name: current.type === "corner" ? "S?" : "T?",
        startFrac: midFrac,
        endFrac: current.endFrac,
        startIdx: 0,
        endIdx: 0,
      };
      next[afterIdx] = { ...current, endFrac: midFrac };
      next.splice(afterIdx + 1, 0, newSeg);
      return next;
    });
  }, []);

  const removeSegment = useCallback((idx: number) => {
    setEditSegments((prev) => {
      if (prev.length <= 1) return prev;
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      // Extend the previous segment to cover the gap
      if (idx > 0) {
        next[idx - 1] = { ...next[idx - 1], endFrac: removed.endFrac };
      } else if (next.length > 0) {
        next[0] = { ...next[0], startFrac: removed.startFrac };
      }
      return next;
    });
  }, []);

  const saveSegments = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/tracks/${track.ordinal}/segments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: editSegments }),
      });
      if (res.ok) {
        setSectors({ segments: editSegments, totalDist: sectors?.totalDist ?? 0 });
        setEditing(false);
      }
    } catch {}
    setSaving(false);
  }, [editSegments, track.ordinal, sectors]);

  const corners = displaySectors?.segments.filter((s) => s.type === "corner") ?? [];
  const straights = displaySectors?.segments.filter((s) => s.type === "straight") ?? [];

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

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Large track map */}
        <div className="bg-slate-950 rounded-lg border border-slate-800 relative" style={{ height: 600 }}>
          {track.hasOutline ? (
            <canvas ref={canvasRef} className="w-full h-full" />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-slate-600">
              No outline available
            </div>
          )}
          {/* Zoom controls */}
          <div className="absolute top-2 right-2 flex flex-col gap-1">
            <button
              onClick={() => setZoom((z) => Math.min(z + 0.25, 4))}
              className="w-7 h-7 text-sm bg-slate-800/80 border border-slate-700 text-slate-400 hover:text-white rounded flex items-center justify-center"
            >+</button>
            <button
              onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
              className="w-7 h-7 text-sm bg-slate-800/80 border border-slate-700 text-slate-400 hover:text-white rounded flex items-center justify-center"
            >-</button>
            {zoom !== 1 && (
              <button
                onClick={() => setZoom(1)}
                className="w-7 h-7 text-[10px] bg-slate-800/80 border border-slate-700 text-slate-400 hover:text-white rounded flex items-center justify-center"
              >1x</button>
            )}
          </div>
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
                <div className="font-mono text-white">{displaySectors?.segments.length ?? 0}</div>
              </div>
            </div>
          </div>

          {/* Segment list / editor */}
          {displaySectors && displaySectors.segments.length > 0 && (
            <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-slate-500 uppercase tracking-wider">Segments</div>
                {!editing ? (
                  <button
                    onClick={startEditing}
                    className="text-[10px] text-cyan-400 hover:text-cyan-300 px-2 py-0.5 rounded bg-cyan-900/30 border border-cyan-800/50"
                  >
                    Edit
                  </button>
                ) : (
                  <div className="flex gap-1">
                    <button
                      onClick={saveSegments}
                      disabled={saving}
                      className="text-[10px] text-emerald-400 hover:text-emerald-300 px-2 py-0.5 rounded bg-emerald-900/30 border border-emerald-800/50 disabled:opacity-50"
                    >
                      {saving ? "..." : "Save"}
                    </button>
                    <button
                      onClick={() => setEditing(false)}
                      className="text-[10px] text-slate-400 hover:text-slate-300 px-2 py-0.5 rounded bg-slate-800 border border-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-0.5 max-h-[420px] overflow-auto">
                {(editing ? editSegments : displaySectors.segments).map((seg, i) => {
                  const pct = ((seg.endFrac - seg.startFrac) * 100).toFixed(1);
                  const isCorner = seg.type === "corner";
                  const color = isCorner ? "text-red-400" : "text-blue-400";
                  const bg = isCorner ? "bg-red-500/10" : "bg-blue-500/10";

                  if (!editing) {
                    return (
                      <div key={i} className={`flex items-center justify-between px-2 py-1 rounded ${bg}`}>
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-mono font-bold ${color}`}>{seg.name}</span>
                          <span className="text-[10px] text-slate-500 capitalize">{seg.type}</span>
                        </div>
                        <span className="text-[10px] font-mono text-slate-400">{pct}%</span>
                      </div>
                    );
                  }

                  return (
                    <div key={i} className={`px-2 py-1.5 rounded ${bg} space-y-1`}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleSegType(i)}
                          className={`text-[10px] font-bold px-1 rounded ${isCorner ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}
                        >
                          {isCorner ? "T" : "S"}
                        </button>
                        <input
                          value={seg.name}
                          onChange={(e) => updateSegName(i, e.target.value)}
                          className="flex-1 text-xs font-mono bg-transparent border-b border-slate-700 text-white outline-none px-1"
                        />
                        <button
                          onClick={() => addSegment(i)}
                          className="text-[10px] text-slate-500 hover:text-white px-1"
                          title="Split segment"
                        >+</button>
                        <button
                          onClick={() => removeSegment(i)}
                          className="text-[10px] text-slate-500 hover:text-red-400 px-1"
                          title="Remove segment"
                        >x</button>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={(seg.startFrac * 100).toFixed(1)}
                          onChange={(e) => updateSegFrac(i, "startFrac", Number(e.target.value) / 100)}
                          className="w-14 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-white text-center"
                        />
                        <span>-</span>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={(seg.endFrac * 100).toFixed(1)}
                          onChange={(e) => updateSegFrac(i, "endFrac", Number(e.target.value) / 100)}
                          className="w-14 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-white text-center"
                        />
                        <span className="text-slate-600">({pct}%)</span>
                      </div>
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
function drawTrack(canvas: HTMLCanvasElement, outline: Point[], large: boolean, sectors?: TrackSectors | null, zoom: number = 1) {
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
  const baseScale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeZ);
  const scale = baseScale * zoom;
  const offsetX = (w - rangeX * scale) / 2;
  const offsetZ = (h - rangeZ * scale) / 2;

  function toCanvas(x: number, z: number): [number, number] {
    return [offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
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
  // Alternating color palettes for distinct segment visibility
  const cornerColors = ["#ef4444", "#f97316", "#ec4899", "#f59e0b", "#e11d48", "#d946ef"];
  const straightColors = ["#3b82f6", "#06b6d4", "#8b5cf6", "#2dd4bf", "#6366f1", "#0ea5e9"];

  if (sectors && sectors.segments.length > 0) {
    const n = outline.length;
    let cornerIdx = 0, straightIdx = 0;

    for (const seg of sectors.segments) {
      const start = Math.round(seg.startFrac * n);
      const end = Math.min(Math.round(seg.endFrac * n), n - 1);
      const color = seg.type === "corner"
        ? cornerColors[cornerIdx++ % cornerColors.length]
        : straightColors[straightIdx++ % straightColors.length];

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = large ? 0.85 : 0.5;
      ctx.lineWidth = large ? 3 : 1.5;
      ctx.lineCap = "round";
      const [fx, fy] = toCanvas(outline[start].x, outline[start].z);
      ctx.moveTo(fx, fy);
      for (let i = start + 1; i <= end; i++) {
        const [px, py] = toCanvas(outline[i].x, outline[i].z);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Boundary dot at segment start
      if (large && start > 0) {
        ctx.beginPath();
        ctx.arc(fx, fy, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

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

  // Direction arrow from start point — use ~0.5% of outline (just a few meters ahead)
  const arrowIdx = Math.min(Math.max(3, Math.floor(outline.length * 0.005)), outline.length - 1);
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
  const routeSearch = useSearch({ from: "/tracks" });
  const navigate = useNavigate({ from: "/tracks" });

  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrack, setSelectedTrack] = useState<TrackInfo | null>(null);
  const [search, setSearch] = useState("");

  const handleSelectTrack = useCallback((t: TrackInfo) => {
    setSelectedTrack(t);
    navigate({ search: { track: t.ordinal }, replace: true });
  }, [navigate]);

  const handleBack = useCallback(() => {
    setSelectedTrack(null);
    navigate({ search: {}, replace: true });
  }, [navigate]);

  useEffect(() => {
    fetch("/api/tracks")
      .then((r) => r.json())
      .then((data: TrackInfo[]) => {
        setTracks(data);
        // If URL has a track param, select it
        if (routeSearch.track) {
          const match = data.find((t) => t.ordinal === routeSearch.track);
          if (match) setSelectedTrack(match);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-4 text-slate-600">Loading tracks...</div>;
  }

  if (selectedTrack) {
    return <TrackDetail track={selectedTrack} onBack={handleBack} />;
  }

  const query = search.toLowerCase().trim();
  const filtered = query
    ? tracks.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.variant.toLowerCase().includes(query) ||
          t.location.toLowerCase().includes(query) ||
          t.country.toLowerCase().includes(query),
      )
    : tracks;

  const withOutline = filtered.filter((t) => t.hasOutline);
  const withoutOutline = filtered.filter((t) => !t.hasOutline);

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-xs text-slate-500 uppercase tracking-wider whitespace-nowrap">
          Available Tracks ({withOutline.length} with outlines, {withoutOutline.length} without)
        </div>
        <input
          type="text"
          placeholder="Search tracks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 w-full max-w-xs rounded-md border border-slate-700 bg-slate-900/50 px-2.5 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:border-slate-500 transition-colors"
        />
      </div>

      {filtered.length === 0 && (
        <div className="text-sm text-slate-600 mt-6">No tracks matching &ldquo;{search}&rdquo;</div>
      )}

      {withOutline.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mb-6">
          {withOutline.map((t) => (
            <TrackCard key={t.ordinal} track={t} onSelect={handleSelectTrack} />
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
                onClick={() => handleSelectTrack(t)}
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
