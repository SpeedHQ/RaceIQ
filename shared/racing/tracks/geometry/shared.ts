import { resolve } from "node:path";
import { SHARED_DIR } from "@shared/platform/runtime/data-paths";
import { readDataFile } from "../storage/files";
import type { Point } from "./types";

const tumftmDir = resolve(SHARED_DIR, "tracks", "tumftm");

/** Load a shared outline CSV by name (e.g. "silverstone"). */
const sharedOutlineCache = new Map<string, Point[] | null>();
export function loadSharedOutline(name: string): Point[] | null {
  if (!name) return null;
  const cached = sharedOutlineCache.get(name);
  if (cached !== undefined) return cached;
  const content =
    readDataFile(resolve(tumftmDir, `${name}.csv`)) ??
    readDataFile(resolve(tumftmDir, `${name}-centerline.csv`));
  if (!content) { sharedOutlineCache.set(name, null); return null; }
  try {
    const lines = content.split("\n").filter(Boolean);
    const data: Point[] = lines.slice(1).map((l) => {
      const [x, z] = l.split(",").map(Number);
      return { x, z };
    });
    const result = data.length > 10 ? data : null;
    sharedOutlineCache.set(name, result);
    return result;
  } catch { sharedOutlineCache.set(name, null); return null; }
}

/** Load shared boundary JSON by name (e.g. "silverstone"). */
export type SharedBoundaryData = { leftEdge: Point[]; rightEdge: Point[]; centerLine: Point[]; pitLane: Point[] | null; coordSystem: string };
const sharedBoundaryCache = new Map<string, SharedBoundaryData | null>();
export function loadSharedBoundary(name: string): SharedBoundaryData | null {
  if (!name) return null;
  const cached = sharedBoundaryCache.get(name);
  if (cached !== undefined) return cached;
  const content =
    readDataFile(resolve(tumftmDir, `${name}.json`)) ??
    readDataFile(resolve(tumftmDir, `${name}-boundaries.json`));
  if (!content) { sharedBoundaryCache.set(name, null); return null; }
  try {
    const data = JSON.parse(content);
    sharedBoundaryCache.set(name, data);
    return data;
  } catch { sharedBoundaryCache.set(name, null); return null; }
}
