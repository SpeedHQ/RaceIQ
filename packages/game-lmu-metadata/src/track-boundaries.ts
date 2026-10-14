import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";
import { lmuTrackCatalog } from "./catalog";
import type { Point, TrackBoundary } from "@raceiq/shared/racing/tracks/geometry/types";
import { applyAlignment, computeAlignment } from "@raceiq/shared/racing/tracks/geometry/points";
import { loadTrackGeometryCenterline } from "@raceiq/shared/racing/tracks/storage/meta";

const cache = new Map<string, (TrackBoundary & { raceLine: Point[] | null }) | null>();
const tracksById = new Map(lmuTrackCatalog.map((track) => [track.id, track]));
const outlineCache = new Map<string, Point[] | null>();

function parsePath(svg: string, id: string): Point[] | null {
  let data: string | undefined;
  for (const path of svg.matchAll(/<path\b([^>]*)>/gi)) {
    let matches = false;
    let pathData: string | undefined;
    // Match attributes independently: overlapping wildcards backtrack on long paths.
    for (const attribute of path[1].matchAll(/\s(id|class|d)\s*=\s*(["'])(.*?)\2/gi)) {
      const name = attribute[1].toLowerCase();
      const value = attribute[3];
      if (name === "id" && value.toLowerCase() === id) matches = true;
      if (name === "class" && value.toLowerCase().split(/\s+/).includes(id)) matches = true;
      if (name === "d") pathData = value;
    }
    if (matches && pathData) {
      data = pathData;
      break;
    }
  }
  if (!data) return null;
  const tokens = data.match(/[MLZ]|[-+]?(?:\d*\.)?\d+/gi) ?? [];
  const points: Point[] = [];
  let index = 0;
  let command = "";
  while (index < tokens.length) {
    if (/^[MLZ]$/i.test(tokens[index])) command = tokens[index++].toUpperCase();
    if (command === "Z") break;
    if (command !== "M" && command !== "L") break;
    if (index + 1 >= tokens.length || /^[MLZ]$/i.test(tokens[index]) || /^[MLZ]$/i.test(tokens[index + 1])) break;
    points.push({ x: Number(tokens[index++]), z: Number(tokens[index++]) });
    if (command === "M") command = "L";
  }
  return points.length > 10 ? points : null;
}

/** Load LMU's shipped track-limit geometry from its catalog SVG asset. */
export function getLMUTrackBoundaries(trackId: string): (TrackBoundary & { raceLine: Point[] | null }) | null {
  if (cache.has(trackId)) return cache.get(trackId)!;
  const track = tracksById.get(trackId);
  if (!track) { cache.set(trackId, null); return null; }
  const file = resolve(gameAssetsDir("lmu"), track.boundariesSvg);
  if (!existsSync(file)) { cache.set(trackId, null); return null; }
  try {
    const svg = readFileSync(file, "utf8");
    const leftEdge = parsePath(svg, "left");
    const rightEdge = parsePath(svg, "right");
    const centerLine = parsePath(svg, "center-line");
    if (!leftEdge || !rightEdge || !centerLine) { cache.set(trackId, null); return null; }
    const result = { leftEdge, rightEdge: rightEdge.reverse(), centerLine, pitLane: parsePath(svg, "pit-lane"), raceLine: parsePath(svg, "racing-line") };
    cache.set(trackId, result);
    return result;
  } catch {
    cache.set(trackId, null);
    return null;
  }
}

/**
 * Preserve the native SVG shape, but use the selected common geometry's lap
 * origin and direction so its segment fractions land on the right corners.
 * Track-limit edge pairing remains untouched.
 */
export function getLMUTrackOutline(trackId: string): Point[] | null {
  if (outlineCache.has(trackId)) return outlineCache.get(trackId)!;
  const native = getLMUTrackBoundaries(trackId)?.centerLine ?? null;
  const slug = tracksById.get(trackId)?.commonTrackName;
  const reference = slug ? loadTrackGeometryCenterline(slug, "lmu") : null;
  const alignment = native && reference ? computeAlignment(reference, native) : null;
  if (!native || !reference || !alignment) {
    outlineCache.set(trackId, native);
    return native;
  }

  const start = applyAlignment(reference[0], alignment);
  const ahead = applyAlignment(reference[1], alignment);
  const last = native[native.length - 1];
  const count = last.x === native[0].x && last.z === native[0].z ? native.length - 1 : native.length;
  let index = 0;
  let distance = Infinity;
  for (let i = 0; i < count; i++) {
    const squared = (native[i].x - start.x) ** 2 + (native[i].z - start.z) ** 2;
    if (squared < distance) { distance = squared; index = i; }
  }
  const next = native[(index + 1) % count];
  const previous = native[(index + count - 1) % count];
  const direction = (next.x - previous.x) * (ahead.x - start.x) + (next.z - previous.z) * (ahead.z - start.z) >= 0 ? 1 : -1;
  const outline = new Array<Point>(count + 1);
  for (let i = 0; i < count; i++) outline[i] = native[(index + direction * i + count) % count];
  outline[count] = outline[0];
  outlineCache.set(trackId, outline);
  return outline;
}
