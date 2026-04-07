import type { Point, TrackSectors } from "@/components/track/types";

/**
 * drawTrack — Shared canvas rendering for both gallery thumbnails and detail views.
 * Draws a thick base outline, then overlays color-coded segments (corner/straight).
 * Segment labels are offset perpendicular to the track direction so they don't overlap the line.
 * The perpendicular offset is computed from neighboring outline points' tangent vector.
 */
export function drawTrack(canvas: HTMLCanvasElement, outline: Point[], large: boolean, sectors?: TrackSectors | null, zoom: number = 1, pan: { x: number; z: number } = { x: 0, z: 0 }, sectorOverride?: { s1End: number; s2End: number }) {
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
  const offsetX = (w - rangeX * scale) / 2 + pan.x;
  const offsetZ = (h - rangeZ * scale) / 2 + pan.z;

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

  // Sector override mode: draw S1/S2/S3 as colored bands, suppressing segment coloring
  if (sectorOverride) {
    const n = outline.length;
    const sectorDefs = [
      { label: "S1", color: "#ef4444", start: 0, end: sectorOverride.s1End },
      { label: "S2", color: "#3b82f6", start: sectorOverride.s1End, end: sectorOverride.s2End },
      { label: "S3", color: "#eab308", start: sectorOverride.s2End, end: 1 },
    ];
    for (const sec of sectorDefs) {
      const startIdx = Math.round(sec.start * (n - 1));
      const endIdx = Math.min(Math.round(sec.end * (n - 1)), n - 1);
      if (startIdx >= endIdx) continue;
      ctx.beginPath();
      ctx.strokeStyle = sec.color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      const [fx, fy] = toCanvas(outline[startIdx].x, outline[startIdx].z);
      ctx.moveTo(fx, fy);
      for (let i = startIdx + 1; i <= endIdx; i++) {
        const [px, py] = toCanvas(outline[i].x, outline[i].z);
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Boundary dot at sector start (except S1 which starts at finish)
      if (startIdx > 0) {
        ctx.beginPath();
        ctx.arc(fx, fy, 5, 0, Math.PI * 2);
        ctx.fillStyle = sec.color;
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Label at midpoint
      const midIdx = Math.round((startIdx + endIdx) / 2);
      const midPt = outline[Math.min(midIdx, n - 1)];
      const [mx, my] = toCanvas(midPt.x, midPt.z);
      const prevIdx = Math.max(0, midIdx - 2);
      const nextIdx2 = Math.min(n - 1, midIdx + 2);
      const dx2 = outline[nextIdx2].x - outline[prevIdx].x;
      const dz2 = outline[nextIdx2].z - outline[prevIdx].z;
      const len2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;
      const offDist = 16;
      const lx = mx + (-dz2 / len2) * offDist;
      const ly = my + (dx2 / len2) * offDist;
      ctx.font = "bold 11px monospace";
      ctx.textAlign = "center";
      const textWidth = ctx.measureText(sec.label).width;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.roundRect(lx - textWidth / 2 - 4, ly - 9, textWidth + 8, 13, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = sec.color;
      ctx.fillText(sec.label, lx, ly + 1);
    }
  }

  // Inner line — color-coded by segment type. startFrac/endFrac map [0,1] to outline indices.
  // Alternating color palettes for distinct segment visibility
  const cornerColors = ["#ef4444", "#f97316", "#ec4899", "#f59e0b", "#e11d48", "#d946ef"];
  const straightColors = ["#3b82f6", "#06b6d4", "#8b5cf6", "#2dd4bf", "#6366f1", "#0ea5e9"];

  if (!sectorOverride && sectors && sectors.segments.length > 0) {
    const n = outline.length;
    let cornerIdx = 0, straightIdx = 0;

    // Build display names: auto-number unnamed straights
    let sNum = 1;
    const displayNames = sectors.segments.map((s) => {
      if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) return `S${sNum++}`;
      if (s.type === "straight") sNum++;
      return s.name;
    });

    let segIdx = 0;
    for (const seg of sectors.segments) {
      const displayName = displayNames[segIdx++];
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
        ctx.textAlign = "center";
        // Background pill behind label
        const textWidth = ctx.measureText(displayName).width;
        const padX = 3, padY = 2;
        ctx.globalAlpha = large ? 0.85 : 0.6;
        ctx.fillStyle = "#0f172a";
        ctx.beginPath();
        ctx.roundRect(lx - textWidth / 2 - padX, ly + 3 - 7 - padY, textWidth + padX * 2, 10 + padY * 2, 3);
        ctx.fill();
        // Label text
        ctx.globalAlpha = large ? 0.95 : 0.8;
        ctx.fillStyle = color;
        ctx.fillText(displayName, lx, ly + 3);
        ctx.globalAlpha = 1;
      }
    }
  } else if (!sectorOverride) {
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
