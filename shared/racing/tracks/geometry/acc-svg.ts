import { resolve } from "node:path";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { readDataFile } from "../storage/files";
import type { TrackBoundary } from "./types";

const accTrackDir = resolve(SHARED_DIR, "tracks", "acc");
const boundaryCache = new Map<string, TrackBoundary | null>();

type XY = { x: number; y: number };

function parsePath(svg: string, className: string): XY[] | null {
  const paths = [...svg.matchAll(/<path\b([^>]*?)\bd="([^"]*)"([^>]*)>/gs)];
  const d = paths.find(([_, before, , after]) =>
    `${before} ${after}`
      .match(/\bclass="([^"]*)"/)?.[1]
      .split(/\s+/)
      .includes(className),
  )?.[2];
  if (!d) return null;
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return null;
  const points: XY[] = [];
  let i = 0,
    command = "",
    current: XY = { x: 0, y: 0 },
    start: XY | null = null;
  const number = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) command = tokens[i++];
    if (command === "M" || command === "L") {
      current = { x: number(), y: number() };
      if (command === "M") {
        start = current;
        command = "L";
      }
      points.push(current);
    } else if (command === "C") {
      const p0 = current,
        p1 = { x: number(), y: number() },
        p2 = { x: number(), y: number() },
        p3 = { x: number(), y: number() };
      const controlLength = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
      const count = Math.max(1, Math.ceil(controlLength / 0.25));
      for (let j = 1; j <= count; j++) {
        const t = j / count,
          u = 1 - t;
        points.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
      }
      current = p3;
    } else if (command === "Z" || command === "z") {
      if (start && (current.x !== start.x || current.y !== start.y)) points.push(start);
      current = start ?? current;
      command = "";
    } else return null;
  }
  return points.length >= 2 ? points : null;
}

function length(points: XY[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}
function sample(points: XY[], count: number): XY[] {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = cumulative[cumulative.length - 1],
    result: XY[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (seg < cumulative.length - 1 && cumulative[seg] < target) seg++;
    const span = cumulative[seg] - cumulative[seg - 1],
      t = span ? (target - cumulative[seg - 1]) / span : 0,
      a = points[seg - 1],
      b = points[seg];
    result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return result;
}
function nearest(points: XY[], p: XY): number {
  let best = 0,
    dist = Infinity;
  points.forEach((q, i) => {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < dist) {
      best = i;
      dist = d;
    }
  });
  return best;
}
function align(points: XY[], racing: XY[]): XY[] {
  const start = nearest(points, racing[0]),
    forward = points[(start + Math.min(20, points.length - 1)) % points.length],
    backward = points[(start - Math.min(20, points.length - 1) + points.length) % points.length];
  const target = racing[Math.min(20, racing.length - 1)];
  if ((forward.x - target.x) ** 2 + (forward.y - target.y) ** 2 > (backward.x - target.x) ** 2 + (backward.y - target.y) ** 2) points = [...points].reverse();
  const index = nearest(points, racing[0]);
  return points.slice(index).concat(points.slice(0, index));
}

export function loadAccSvgBoundaryByName(slug: string): TrackBoundary | null {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const cached = boundaryCache.get(slug);
  if (cached !== undefined) return cached;
  const svg = readDataFile(resolve(accTrackDir, `${slug}.track.svg`));
  if (!svg) {
    boundaryCache.set(slug, null);
    return null;
  }
  const leftRaw = parsePath(svg, "left"),
    rightRaw = parsePath(svg, "right"),
    centerRaw = parsePath(svg, "center-line"),
    racing = parsePath(svg, "racing-line"),
    pitRaw = parsePath(svg, "pit-lane");
  if (!leftRaw || !rightRaw || !centerRaw || !racing) {
    boundaryCache.set(slug, null);
    return null;
  }
  const count = Math.max(3, Math.ceil(Math.max(length(leftRaw), length(rightRaw)) / 2));
  const left = align(sample(leftRaw, count), racing);
  const right = align(sample(rightRaw, count), racing);
  const result: TrackBoundary = {
    leftEdge: left.map((p) => ({ x: p.x, z: p.y })),
    rightEdge: right.map((p) => ({ x: p.x, z: p.y })),
    centerLine: centerRaw.map((p) => ({ x: p.x, z: p.y })),
    pitLane: pitRaw?.map((p) => ({ x: p.x, z: p.y })) ?? null,
  };
  boundaryCache.set(slug, result);
  return result;
}
