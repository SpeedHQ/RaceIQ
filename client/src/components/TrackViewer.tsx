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

interface TrackSectors {
  s1End: number;
  s2End: number;
}

function TrackCard({ track }: { track: TrackInfo }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [sectors, setSectors] = useState<TrackSectors | null>(null);
  const [selected, setSelected] = useState(false);

  useEffect(() => {
    if (!track.hasOutline) return;
    fetch(`/api/track-outline/${track.ordinal}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setOutline)
      .catch(() => {});
    fetch(`/api/track-sectors/${track.ordinal}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setSectors)
      .catch(() => {});
  }, [track.ordinal, track.hasOutline]);

  useEffect(() => {
    if (!outline || !canvasRef.current) return;
    drawTrack(canvasRef.current, outline, selected, sectors);
  }, [outline, selected, sectors]);

  return (
    <div
      className={`border rounded-lg overflow-hidden cursor-pointer transition-all ${
        selected
          ? "border-cyan-500 bg-slate-800/80"
          : "border-slate-800 bg-slate-900/50 hover:border-slate-700"
      }`}
      onClick={() => setSelected(!selected)}
    >
      <div className="p-3">
        <div className="text-sm font-medium text-white">{track.name}</div>
        <div className="text-xs text-slate-500">
          {track.variant} &middot; {track.location}, {track.country.toUpperCase()}
          {track.lengthKm > 0 && ` &middot; ${track.lengthKm} km`}
        </div>
      </div>
      <div className="bg-slate-950" style={{ height: selected ? 300 : 150 }}>
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

  // Inner line
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

  // Sector boundary markers
  if (sectors) {
    const sectorColors = [
      { frac: sectors.s1End, color: "#ef4444", label: "S1" }, // red
      { frac: sectors.s2End, color: "#3b82f6", label: "S2" }, // blue
    ];
    const n = outline.length;

    for (const { frac, color, label } of sectorColors) {
      const idx = Math.round(frac * n) % n;
      const point = outline[idx];
      const [bx, by] = toCanvas(point.x, point.z);

      // Draw a perpendicular tick mark at sector boundary
      const prevIdx = (idx - 1 + n) % n;
      const nextIdx = (idx + 1) % n;
      const dx = outline[nextIdx].x - outline[prevIdx].x;
      const dz = outline[nextIdx].z - outline[prevIdx].z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      // Perpendicular direction (normalized)
      const perpX = -dz / len;
      const perpZ = dx / len;
      const tickLen = large ? 10 : 6;

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = large ? 3 : 2;
      ctx.lineCap = "round";
      const [t1x, t1y] = toCanvas(
        point.x + perpX * tickLen / scale,
        point.z + perpZ * tickLen / scale
      );
      const [t2x, t2y] = toCanvas(
        point.x - perpX * tickLen / scale,
        point.z - perpZ * tickLen / scale
      );
      ctx.moveTo(t1x, t1y);
      ctx.lineTo(t2x, t2y);
      ctx.stroke();

      // Sector dot
      ctx.beginPath();
      ctx.arc(bx, by, large ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Label (only when expanded)
      if (large) {
        ctx.font = "bold 10px system-ui";
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.fillText(label, bx, by - 8);
      }
    }
  }

  // Start marker
  ctx.beginPath();
  ctx.arc(sx, sy, large ? 5 : 3, 0, Math.PI * 2);
  ctx.fillStyle = "#10b981";
  ctx.fill();

  // S3 label at start/finish (only when expanded)
  if (sectors && large) {
    ctx.font = "bold 10px system-ui";
    ctx.fillStyle = "#eab308"; // yellow for S3
    ctx.textAlign = "center";
    ctx.fillText("S3", sx, sy - 8);
  }
}

export function TrackViewer() {
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [loading, setLoading] = useState(true);

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
            <TrackCard key={t.ordinal} track={t} />
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
                className="border border-slate-800 rounded-lg p-3 bg-slate-900/30"
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
