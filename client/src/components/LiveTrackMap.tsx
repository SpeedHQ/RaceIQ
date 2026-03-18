import { useEffect, useRef, useState, useCallback } from "react";
import type { TelemetryPacket } from "@shared/types";

interface Props {
  packet: TelemetryPacket | null;
}

interface Point {
  x: number;
  z: number;
}

interface TrackSectors {
  s1End: number;
  s2End: number;
}

export function LiveTrackMap({ packet }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [sectors, setSectors] = useState<TrackSectors | null>(null);
  const [noOutline, setNoOutline] = useState(false);
  const lastTrackOrdRef = useRef<number | null>(null);

  // Live trace: build outline from driving data when no pre-made outline exists
  const liveTraceRef = useRef<Point[]>([]);
  const lastTracePos = useRef<Point | null>(null);
  const traceMinDist = 3; // minimum meters between recorded points

  // Fetch track outline and sectors when session/track changes
  const fetchOutline = useCallback(async () => {
    try {
      const statusRes = await fetch("/api/status");
      if (!statusRes.ok) return;
      const status = await statusRes.json();
      const trackOrd = status.currentSession?.trackOrdinal;
      if (trackOrd == null || trackOrd === lastTrackOrdRef.current) return;
      lastTrackOrdRef.current = trackOrd;

      const [outlineRes, sectorsRes] = await Promise.all([
        fetch(`/api/track-outline/${trackOrd}`),
        fetch(`/api/track-sectors/${trackOrd}`),
      ]);

      if (outlineRes.ok) {
        const data = await outlineRes.json();
        setOutline(data);
        setNoOutline(false);
      } else {
        setOutline(null);
        setNoOutline(true);
      }

      if (sectorsRes.ok) {
        const sectorData = await sectorsRes.json();
        setSectors(sectorData);
      }
    } catch {
      setNoOutline(true);
    }
  }, []);

  useEffect(() => {
    fetchOutline();
  }, [fetchOutline]);

  // Refetch when lap changes (might be new session)
  useEffect(() => {
    if (packet && lastTrackOrdRef.current === null) {
      fetchOutline();
    }
  }, [packet?.LapNumber, fetchOutline]);

  // Reset live trace when track changes
  useEffect(() => {
    liveTraceRef.current = [];
    lastTracePos.current = null;
  }, [lastTrackOrdRef.current]);

  // Collect live trace points when no pre-made outline
  useEffect(() => {
    if (!packet || !noOutline) return;
    if (packet.PositionX === 0 && packet.PositionZ === 0) return;

    const pos = { x: packet.PositionX, z: packet.PositionZ };
    const last = lastTracePos.current;

    if (last) {
      const dx = pos.x - last.x;
      const dz = pos.z - last.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < traceMinDist) return;
    }

    liveTraceRef.current.push(pos);
    lastTracePos.current = pos;

    // Cap at 2000 points (enough for most tracks)
    if (liveTraceRef.current.length > 2000) {
      liveTraceRef.current.shift();
    }
  }, [packet, noOutline]);

  // Redraw
  useEffect(() => {
    draw();
  });

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Use live trace as fallback when no pre-made outline
    const displayOutline = outline ?? (liveTraceRef.current.length >= 5 ? liveTraceRef.current : null);

    if (!displayOutline || displayOutline.length < 2) {
      if (noOutline) {
        ctx.fillStyle = "#475569";
        ctx.font = "12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Drive to map track...", w / 2, h / 2);
      }
      return;
    }

    const isLiveTrace = !outline;

    // Find bounds
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of displayOutline) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }

    const rangeX = (maxX - minX) || 1;
    const rangeZ = (maxZ - minZ) || 1;
    const padding = 20;
    const scaleX = (w - padding * 2) / rangeX;
    const scaleZ = (h - padding * 2) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);
    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    function toCanvas(x: number, z: number): [number, number] {
      return [
        offsetX + (x - minX) * scale,
        offsetZ + (z - minZ) * scale,
      ];
    }

    // Draw track outline
    ctx.beginPath();
    ctx.strokeStyle = isLiveTrace ? "#1e3a5f" : "#334155";
    ctx.lineWidth = isLiveTrace ? 3 : 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const [sx, sy] = toCanvas(displayOutline[0].x, displayOutline[0].z);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < displayOutline.length; i++) {
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      ctx.lineTo(px, py);
    }
    if (!isLiveTrace) ctx.lineTo(sx, sy); // only close loop for pre-made outlines
    ctx.stroke();

    // Draw thinner colored line on top
    ctx.beginPath();
    ctx.strokeStyle = isLiveTrace ? "#22d3ee" : "#64748b";
    ctx.lineWidth = isLiveTrace ? 1.5 : 2;
    ctx.globalAlpha = isLiveTrace ? 0.6 : 1;
    ctx.moveTo(sx, sy);
    for (let i = 1; i < displayOutline.length; i++) {
      const [px, py] = toCanvas(displayOutline[i].x, displayOutline[i].z);
      ctx.lineTo(px, py);
    }
    if (!isLiveTrace) ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Sector boundary markers (only for pre-made outlines)
    if (sectors && !isLiveTrace) {
      const sectorMarkers = [
        { frac: sectors.s1End, color: "#ef4444", label: "S1" },
        { frac: sectors.s2End, color: "#3b82f6", label: "S2" },
      ];
      const n = displayOutline.length;

      for (const { frac, color, label } of sectorMarkers) {
        const idx = Math.round(frac * n) % n;
        const point = displayOutline[idx];
        const [bx, by] = toCanvas(point.x, point.z);

        // Perpendicular tick mark
        const prevIdx = (idx - 1 + n) % n;
        const nextIdx = (idx + 1) % n;
        const dx = displayOutline[nextIdx].x - displayOutline[prevIdx].x;
        const dz = displayOutline[nextIdx].z - displayOutline[prevIdx].z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const perpX = -dz / len;
        const perpZ = dx / len;
        const tickLen = 10;

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
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
        ctx.arc(bx, by, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        // Label
        ctx.font = "bold 10px system-ui";
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.fillText(label, bx, by - 8);
      }

      // S3 label at start/finish
      ctx.font = "bold 10px system-ui";
      ctx.fillStyle = "#eab308"; // yellow
      ctx.textAlign = "center";
      ctx.fillText("S3", sx, sy - 8);
    }

    // Start/finish marker
    if (!isLiveTrace) {
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#10b981";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // "Building map..." label for live trace
    if (isLiveTrace) {
      ctx.fillStyle = "#475569";
      ctx.font = "10px system-ui";
      ctx.textAlign = "left";
      ctx.fillText(`Mapping... ${displayOutline.length} pts`, 8, h - 8);
    }

    // Live car position
    if (packet && (packet.PositionX !== 0 || packet.PositionZ !== 0)) {
      const [cx, cy] = toCanvas(packet.PositionX, packet.PositionZ);
      // Glow
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(34, 211, 238, 0.2)";
      ctx.fill();
      // Dot
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#22d3ee";
      ctx.fill();
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{ height: 250 }}
    />
  );
}
