import { resolve } from "node:path";
import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";
import { readDataFile } from "@raceiq/shared/racing/tracks/storage/files";
import type { Point, TrackBoundary } from "@raceiq/shared/racing/tracks/geometry/types";
import { getAMS2DiscoveredTrackName, getAMS2TrackLength } from "./index";

interface LayoutEntry { layout: string; file: string; lengthM: number }
let catalog: LayoutEntry[] | undefined;
const geometryCache = new Map<string, TrackBoundary>();
// Saved Cordoba recordings report 3655.272705 m and follow this archive's
// native geometry. GP (4055 m) and National (2278 m) are different layouts.
const verifiedAliases: Readonly<Record<string, string>> = {
  "cordoba - cordoba_international": "Cordoba",
};

/** Exact variation or explicitly verified full-name alias; no fuzzy guesses. */
export function matchAMS2Layout(name: string, lengthM: number | undefined, entries: LayoutEntry[]): LayoutEntry | null {
  const variation = name.split(" - ").at(-1)?.trim();
  if (!variation) return null;
  const layout = Object.hasOwn(verifiedAliases, name.trim().toLowerCase()) ? verifiedAliases[name.trim().toLowerCase()] : variation;
  const matches = entries.filter(entry => entry.layout.toLowerCase() === layout.toLowerCase());
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (lengthM !== undefined && (!Number.isFinite(lengthM) || lengthM <= 0 || Math.abs(match.lengthM - lengthM) > match.lengthM * 0.01)) return null;
  return match;
}

/** Road-corridor visual references in the same native X/Z space as telemetry. */
export function getAMS2TrackBoundaries(ordinal: number): TrackBoundary | null {
  try {
    const root = resolve(gameAssetsDir("ams2"), "tracks");
    if (!catalog) {
      const content = readDataFile(resolve(root, "catalog.json"));
      if (!content) return null;
      const data = JSON.parse(content);
      if (data.schemaVersion !== 1 || !Array.isArray(data.layouts) || !data.layouts.every((entry: LayoutEntry) => typeof entry.layout === "string" && typeof entry.file === "string" && /^[a-z0-9-]+-boundaries\.json$/.test(entry.file) && Number.isFinite(entry.lengthM) && entry.lengthM > 0)) return null;
      catalog = data.layouts;
    }
    const name = getAMS2DiscoveredTrackName(ordinal);
    if (!name) return null;
    const match = matchAMS2Layout(name, getAMS2TrackLength(ordinal), catalog!);
    if (!match) return null;
    const cached = geometryCache.get(match.layout);
    if (cached) return structuredClone(cached);
    const content = readDataFile(resolve(root, match.file));
    if (!content) return null;
    const data = JSON.parse(content);
    const validPoints = (points: unknown): points is Point[] => Array.isArray(points) && points.length >= 3 && points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.z));
    if (data.layout !== match.layout || data.coordSystem !== "ams2-world" || data.lengthM !== match.lengthM || !validPoints(data.leftEdge) || !validPoints(data.rightEdge) || !validPoints(data.centerLine) || data.leftEdge.length !== data.rightEdge.length || data.leftEdge.length !== data.centerLine.length) return null;
    const result = { leftEdge: data.leftEdge, rightEdge: data.rightEdge, centerLine: data.centerLine, pitLane: null };
    geometryCache.set(match.layout, result);
    return structuredClone(result);
  } catch { return null; }
}
