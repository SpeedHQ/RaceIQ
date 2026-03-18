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

    if (!outline || outline.length < 2) {
      if (noOutline) {
        ctx.fillStyle = "#475569";
        ctx.font = "12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Track outline not available", w / 2, h / 2);
      }
      return;
    }

    // Find bounds
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of outline) {
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
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const [sx, sy] = toCanvas(outline[0].x, outline[0].z);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < outline.length; i++) {
      const [px, py] = toCanvas(outline[i].x, outline[i].z);
      ctx.lineTo(px, py);
    }
    // Close the loop
    ctx.lineTo(sx, sy);
    ctx.stroke();

    // Draw thinner colored line on top
    ctx.beginPath();
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 2;
    ctx.moveTo(sx, sy);
    for (let i = 1; i < outline.length; i++) {
      const [px, py] = toCanvas(outline[i].x, outline[i].z);
      ctx.lineTo(px, py);
    }
    ctx.lineTo(sx, sy);
    ctx.stroke();

    // Sector boundary markers
    if (sectors) {
      const sectorMarkers = [
        { frac: sectors.s1End, color: "#ef4444", label: "S1" }, // red
        { frac: sectors.s2End, color: "#3b82f6", label: "S2" }, // blue
      ];
      const n = outline.length;

      for (const { frac, color, label } of sectorMarkers) {
        const idx = Math.round(frac * n) % n;
        const point = outline[idx];
        const [bx, by] = toCanvas(point.x, point.z);

        // Perpendicular tick mark
        const prevIdx = (idx - 1 + n) % n;
        const nextIdx = (idx + 1) % n;
        const dx = outline[nextIdx].x - outline[prevIdx].x;
        const dz = outline[nextIdx].z - outline[prevIdx].z;
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
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#10b981";
    ctx.fill();
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 1.5;
    ctx.stroke();

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
