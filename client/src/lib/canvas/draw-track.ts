import { segmentDisplayNames, segmentGroupLabels } from "@shared/racing/tracks/segment-label";
import type { Point, TrackSectors } from "@/components/track/types";
import { SECTOR_COLOR_VARS, TRACK_CORNER_COLOR_VARS, TRACK_STRAIGHT_COLOR_VARS } from "@/lib/colors";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";

interface LabelCandidate {
  text: string;
  color: string;
  /** Track-side anchor the label points at. */
  mx: number;
  my: number;
  /** Unit normal to the track, pointing to one side. */
  nx: number;
  ny: number;
  /** Higher wins the space when two labels collide. */
  priority: number;
  /** Lap fraction the section covers — tie-breaker among equal priorities. */
  size: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Draw as many labels as fit without overlapping. Tight infields (Spa's
 * Campus/Les Fagnes/Piff Paff) can't show every name at once, so the most
 * significant ones claim their space first and anything still colliding is
 * dropped — an unreadable pile of overlapping names says less than a clean
 * partial set. Each label tries the outside of the track first, then the
 * inside, before giving up.
 */
function placeLabels(ctx: CanvasRenderingContext2D, labels: LabelCandidate[], large: boolean, w: number, h: number) {
  ctx.font = large ? "var(--font-weight-bold) var(--text-app-micro) var(--font-mono)" : "var(--font-weight-bold) var(--text-app-glyph) var(--font-mono)";
  ctx.textAlign = "center";
  const offDist = large ? 14 : 8;
  const padX = 3;
  const padY = 2;
  const taken: Rect[] = [];

  const ordered = [...labels].sort((a, b) => b.priority - a.priority || b.size - a.size);
  for (const label of ordered) {
    const textWidth = ctx.measureText(label.text).width;
    const rw = textWidth + padX * 2;
    const rh = 10 + padY * 2;

    let placed: { lx: number; ly: number; rect: Rect } | null = null;
    for (const side of [1, -1]) {
      const lx = label.mx + label.nx * offDist * side;
      const ly = label.my + label.ny * offDist * side;
      const rect = { x: lx - rw / 2, y: ly + 3 - 7 - padY, w: rw, h: rh };
      // Off-canvas is as unreadable as overlapping
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > w || rect.y + rect.h > h) continue;
      if (taken.some((t) => overlaps(rect, t))) continue;
      placed = { lx, ly, rect };
      break;
    }
    if (!placed) continue;
    taken.push(placed.rect);

    ctx.globalAlpha = large ? 0.85 : 0.6;
    ctx.fillStyle = "var(--track-label-background)";
    ctx.beginPath();
    ctx.roundRect(placed.rect.x, placed.rect.y, rw, rh, 3);
    ctx.fill();
    ctx.globalAlpha = large ? 0.95 : 0.8;
    ctx.fillStyle = label.color;
    ctx.fillText(label.text, placed.lx, placed.ly + 3);
    ctx.globalAlpha = 1;
  }
}

/**
 * Distance along the outline at each point, cumulative from point 0.
 * Lets a distance fraction (e.g. a sector boundary at 0.34 of the lap) be mapped
 * to the right point, which raw indexing gets wrong when points are unevenly spaced.
 */
function cumulativeDistances(outline: Point[]): number[] {
  const cumulative = new Array<number>(outline.length);
  cumulative[0] = 0;
  for (let i = 1; i < outline.length; i++) {
    const dx = outline[i].x - outline[i - 1].x;
    const dz = outline[i].z - outline[i - 1].z;
    cumulative[i] = cumulative[i - 1] + Math.sqrt(dx * dx + dz * dz);
  }
  return cumulative;
}

/**
 * drawTrack — Shared canvas rendering for both gallery thumbnails and detail views.
 * Draws a thick base outline, then overlays color-coded segments (corner/straight).
 * Segment labels are offset perpendicular to the track direction so they don't overlap the line.
 * The perpendicular offset is computed from neighboring outline points' tangent vector.
 */
export function drawTrack(
  canvas: HTMLCanvasElement,
  outline: Point[],
  large: boolean,
  sectors?: TrackSectors | null,
  zoom: number = 1,
  pan: { x: number; z: number } = { x: 0, z: 0 },
  sectorOverride?: { starts: number[] },
  flipX?: boolean,
  sectorColors?: string[],
  /** Debug editing: label every segment individually instead of once per group. */
  perSegmentLabels?: boolean,
) {
  const ctx = getSemanticCanvasContext(canvas);
  if (!ctx || outline.length < 2) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }

  const rangeX = maxX - minX || 1;
  const rangeZ = maxZ - minZ || 1;
  const padding = large ? 20 : 12;
  const baseScale = Math.min((w - padding * 2) / rangeX, (h - padding * 2) / rangeZ);
  const scale = baseScale * zoom;
  const offsetX = (w - rangeX * scale) / 2 + pan.x;
  const offsetZ = (h - rangeZ * scale) / 2 + pan.z;

  function toCanvas(x: number, z: number): [number, number] {
    return [flipX ? offsetX + (x - minX) * scale : offsetX + (maxX - x) * scale, offsetZ + (z - minZ) * scale];
  }

  // Track outline
  ctx.beginPath();
  ctx.strokeStyle = large ? "var(--track-outline-strong)" : "var(--track-outline)";
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

  // Sector override mode: draw source-defined sector bands, suppressing segment coloring.
  if (sectorOverride) {
    const n = outline.length;
    const palette = sectorColors ?? SECTOR_COLOR_VARS;
    const sectorDefs = sectorOverride.starts.map((start, index) => ({
      label: `S${index + 1}`,
      color: palette[index % palette.length],
      start,
      end: sectorOverride.starts[index + 1] ?? 1,
    }));
    // s1End/s2End are fractions of LAP DISTANCE, and outline points are not evenly
    // spaced — so map them through cumulative arc length. Using the raw point index
    // put the boundaries wherever the points happened to bunch up.
    const cumulative = cumulativeDistances(outline);
    const totalLength = cumulative[n - 1];
    const indexAtFraction = (frac: number): number => {
      if (!(totalLength > 0) || frac <= 0) return 0;
      if (frac >= 1) return n - 1;
      const target = frac * totalLength;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] < target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (const sec of sectorDefs) {
      const startIdx = indexAtFraction(sec.start);
      const endIdx = Math.min(indexAtFraction(sec.end), n - 1);
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
        ctx.strokeStyle = "var(--track-label-background)";
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
      ctx.font = "var(--font-weight-bold) var(--text-app-compact) var(--font-mono)";
      ctx.textAlign = "center";
      const textWidth = ctx.measureText(sec.label).width;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "var(--track-label-background)";
      ctx.beginPath();
      ctx.roundRect(lx - textWidth / 2 - 4, ly - 9, textWidth + 8, 13, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = sec.color;
      ctx.fillText(sec.label, lx, ly + 1);
    }
  }

  // Inner line — color-coded by segment type. startFrac/endFrac map [0,1] to outline indices.
  // Rotate one theme-owned series so adjacent corner/straight groups remain distinct.
  if (!sectorOverride && sectors && sectors.segments.length > 0) {
    const n = outline.length;
    let cornerIdx = 0,
      straightIdx = 0;
    const labels: LabelCandidate[] = [];

    // Corner names carry their official turn numbers ("Eau Rouge/Raidillon (2-4)");
    // thumbnails stay clean with names only.
    const forLabels = large ? sectors.segments : sectors.segments.map((s) => ({ ...s, number: undefined, covers: undefined }));
    // A complex (Rivazza, Les Combes) is one section per turn so each can be
    // edited on its own, but the map names the piece once. `segmentGroupLabels`
    // labels the first member and returns "" for the rest, which is the same
    // helper the prompts and lists use — this used to be reimplemented here,
    // anchoring on the longest member instead of the first and emitting the bare
    // group name, so the map disagreed with every other surface. Debug editing
    // wants every turn labelled, so it opts out.
    const labelTexts = perSegmentLabels ? segmentDisplayNames(forLabels) : segmentGroupLabels(forLabels);

    let segIdx = 0;
    for (const seg of sectors.segments) {
      // "" means this segment is a non-anchor member of a group, so the piece
      // is already labelled once at its first member.
      const labelText = labelTexts[segIdx++];
      const start = Math.round(seg.startFrac * n);
      const end = Math.min(Math.round(seg.endFrac * n), n - 1);
      const color = seg.type === "corner" ? TRACK_CORNER_COLOR_VARS[cornerIdx++ % TRACK_CORNER_COLOR_VARS.length] : TRACK_STRAIGHT_COLOR_VARS[straightIdx++ % TRACK_STRAIGHT_COLOR_VARS.length];

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
        ctx.strokeStyle = "var(--track-label-background)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Collect the label; placement happens after every segment is drawn so
      // labels can be tested against each other (see placeLabels below).
      if ((large || seg.type === "corner") && labelText) {
        const midIdx = Math.round((start + end) / 2);
        const midPt = outline[Math.min(midIdx, n - 1)];
        const [mx, my] = toCanvas(midPt.x, midPt.z);

        // Perpendicular to the track, so the label sits beside the line not on it
        const prevIdx = Math.max(0, midIdx - 2);
        const nextIdx = Math.min(n - 1, midIdx + 2);
        const dx = outline[nextIdx].x - outline[prevIdx].x;
        const dz = outline[nextIdx].z - outline[prevIdx].z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        labels.push({
          text: labelText,
          color,
          mx,
          my,
          nx: -dz / len,
          ny: dx / len,
          // A real name is worth more screen space than "T6" or "S3"; among
          // equals, the longer section is the more significant one.
          priority: (/^[TS]\d/.test(labelText) ? 0 : 2) + (seg.type === "corner" ? 1 : 0),
          size: seg.endFrac - seg.startFrac,
        });
      }
    }

    placeLabels(ctx, labels, large, w, h);
  } else if (!sectorOverride) {
    ctx.beginPath();
    ctx.strokeStyle = large ? "var(--track-muted)" : "var(--track-edge)";
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
  ctx.fillStyle = "var(--track-start)";
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
      ctx.strokeStyle = "var(--track-start)";
      ctx.lineWidth = large ? 2 : 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - nx * wingLen * 2 + ny * wingLen, tipY - ny * wingLen * 2 - nx * wingLen);
      ctx.lineTo(tipX - nx * wingLen * 2 - ny * wingLen, tipY - ny * wingLen * 2 + nx * wingLen);
      ctx.closePath();
      ctx.fillStyle = "var(--track-start)";
      ctx.fill();
    }
  }
}
