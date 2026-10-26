import { resolve } from "node:path";
import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";
import { readDataFile } from "@raceiq/shared/racing/tracks/storage/files";
import type { Point, TrackBoundary } from "@raceiq/shared/racing/tracks/geometry/types";
import { getAMS2CatalogTrack, getAMS2DiscoveredTrackName, getAMS2TrackLength } from "./index";

interface LayoutEntry { layout: string; trackSvg: string; lengthM: number }
let catalog: LayoutEntry[] | undefined;
const geometryCache = new Map<string, TrackBoundary>();
// Saved Cordoba recordings report 3655.272705 m and follow this archive's
// native geometry. GP (4055 m) and National (2278 m) are different layouts.
const verifiedAliases: Readonly<Record<string, string>> = {
  "cordoba - cordoba_international": "Cordoba",
};

/** Exact variation or explicitly verified full-name alias; no fuzzy guesses. */
export function matchAMS2Layout<T extends { layout: string; lengthM: number }>(name: string, lengthM: number | undefined, entries: T[]): T | null {
  const variation = name.split(" - ").at(-1)?.trim();
  if (!variation) return null;
  const layout = Object.hasOwn(verifiedAliases, name.trim().toLowerCase()) ? verifiedAliases[name.trim().toLowerCase()] : variation;
  const matches = entries.filter(entry => entry.layout.toLowerCase() === layout.toLowerCase());
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (lengthM !== undefined && (!Number.isFinite(lengthM) || lengthM <= 0 || Math.abs(match.lengthM - lengthM) > match.lengthM * 0.01)) return null;
  return match;
}

/** Read the extraction contract's absolute, closed polylines without fitting or resampling. */
export function parseAMS2TrackSvg(svg: string): TrackBoundary | null {
  if (/\btransform\s*=/.test(svg)) return null;
  const number = "[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const polyline = new RegExp(`^M\\s+${number}\\s+${number}(?:\\s+L\\s+${number}\\s+${number})*\\s+Z$`);
  const paths = [...svg.matchAll(/<path\b([^>]*?)\bd="([^"]*)"([^>]*)>/gs)];
  const read = (id: string): Point[] | null => {
    const matches = paths.filter(([, before, , after]) => `${before} ${after}`.match(/\bid="([^"]*)"/)?.[1] === id);
    if (matches.length !== 1) return null;
    const d = matches[0]![2];
    if (!polyline.test(d)) return null;
    const values = d.match(new RegExp(number, "g"))!.map(Number);
    if (values.length < 6 || values.some(value => !Number.isFinite(value))) return null;
    const points: Point[] = [];
    for (let index = 0; index < values.length; index += 2) points.push({ x: values[index]!, z: values[index + 1]! });
    const first = points[0]!, last = points.at(-1)!;
    if (last.x !== first.x || last.z !== first.z) points.push({ ...first });
    return points;
  };
  const leftEdge = read("left"), rightEdge = read("right"), centerLine = read("center-line");
  return leftEdge && rightEdge && centerLine ? { leftEdge, rightEdge, centerLine, pitLane: null } : null;
}

/** SVG road-corridor references in the same native X/Z space as telemetry. */
export function getAMS2TrackBoundaries(ordinal: number): TrackBoundary | null {
  try {
    const root = gameAssetsDir("ams2");
    if (!catalog) {
      const content = readDataFile(resolve(root, "tracks.json"));
      if (!content) return null;
      const data = JSON.parse(content);
      if (data.schemaVersion !== 1 || !Array.isArray(data.tracks) || !data.tracks.every((entry: LayoutEntry) => typeof entry.layout === "string" && typeof entry.trackSvg === "string" && /^tracks\/[a-z0-9-]+\.track\.svg$/.test(entry.trackSvg) && Number.isFinite(entry.lengthM) && entry.lengthM > 0)) return null;
      catalog = data.tracks;
    }
    const name = getAMS2DiscoveredTrackName(ordinal) ?? getAMS2CatalogTrack(String(ordinal))?.geometryLayout;
    if (!name) return null;
    const match = matchAMS2Layout(name, getAMS2TrackLength(ordinal), catalog!);
    if (!match) return null;
    const cached = geometryCache.get(match.layout);
    if (cached) return structuredClone(cached);
    const content = readDataFile(resolve(root, match.trackSvg));
    if (!content) return null;
    const result = parseAMS2TrackSvg(content);
    if (!result) return null;
    geometryCache.set(match.layout, result);
    return structuredClone(result);
  } catch { return null; }
}
