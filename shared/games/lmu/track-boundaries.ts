import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GAMES_DIR } from "@shared/platform/runtime/data-paths";
import { lmuTrackCatalog } from "./catalog";
import type { Point, TrackBoundary } from "../../racing/tracks/geometry/types";

const cache = new Map<string, TrackBoundary | null>();
const tracksById = new Map(lmuTrackCatalog.map((track) => [track.id, track]));

function parsePath(svg: string, id: string): Point[] | null {
  const match = svg.match(new RegExp(`<path\\b[^>]*(?:id=["']${id}["'][^>]*|class=["'][^"']*\\b${id}\\b[^"']*["'][^>]*)[^>]*\\sd=["']([^"']+)["']`, "i"));
  if (!match) return null;
  const tokens = match[1].match(/[MLZ]|[-+]?(?:\d*\.)?\d+/gi) ?? [];
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
export function getLMUTrackBoundaries(trackId: string): TrackBoundary | null {
  if (cache.has(trackId)) return cache.get(trackId)!;
  const track = tracksById.get(trackId);
  if (!track) { cache.set(trackId, null); return null; }
  const file = resolve(GAMES_DIR, "lmu", track.boundariesSvg);
  if (!existsSync(file)) { cache.set(trackId, null); return null; }
  try {
    const svg = readFileSync(file, "utf8");
    const leftEdge = parsePath(svg, "left");
    const rightEdge = parsePath(svg, "right");
    const centerLine = parsePath(svg, "center-line");
    if (!leftEdge || !rightEdge || !centerLine) { cache.set(trackId, null); return null; }
    const result: TrackBoundary = { leftEdge, rightEdge: rightEdge.reverse(), centerLine, pitLane: parsePath(svg, "pit-lane") };
    cache.set(trackId, result);
    return result;
  } catch {
    cache.set(trackId, null);
    return null;
  }
}
