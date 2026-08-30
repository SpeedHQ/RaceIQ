import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { SHARED_DIR } from "../../../shared/platform/runtime/data-paths";
import { canonicalTrackAssetPathComponents, parseCanonicalTrackId } from "../../../shared/racing/tracks/configuration";
import { getTrackRegistryIndexes, type TrackRegistryReadModel } from "../../../shared/racing/tracks/registry";
import { parseIRacingActiveSvg, type IRacingSvgTrackMap } from "./track-map-svg";

type TrackAssignment = TrackRegistryReadModel["assignments"][number];

const completedMaps = new Map<string, IRacingSvgTrackMap>();
const pendingMaps = new Map<string, Promise<IRacingSvgTrackMap>>();
const missingOrdinals = new Set<number>();

async function loadMap(assignment: TrackAssignment): Promise<IRacingSvgTrackMap> {

  const { venuePath, layoutSlug } = parseCanonicalTrackId(assignment.layoutId);
  const layerDirectory = resolve(
    SHARED_DIR,
    "tracks",
    ...canonicalTrackAssetPathComponents(venuePath, layoutSlug),
    "geometry",
    "iracing",
    "official",
  );
  let layers: [string, string, string, string];
  try {
    layers = await Promise.all(
      ["active.svg", "start-finish.svg", "turns.svg", "pit-road.svg"].map((filename) => readFile(resolve(layerDirectory, filename), "utf8")),
    ) as [string, string, string, string];
  } catch (error) {
    throw new Error(`Missing bundled iRacing SVG map layer for track ${assignment.trackOrdinal} (${assignment.layoutId})`, { cause: error });
  }

  const map = parseIRacingActiveSvg(...layers);
  if (!map) throw new Error(`Invalid bundled iRacing active.svg for track ${assignment.trackOrdinal} (${assignment.layoutId})`);
  return map;
}

/** Resolve one exact iRacing layout from bundled SVG layers and memoize its parsed map. */
export function getIRacingSvgTrackMap(ordinal: number): Promise<IRacingSvgTrackMap | null> {
  if (missingOrdinals.has(ordinal)) return Promise.resolve(null);
  const assignment = getTrackRegistryIndexes().assignmentsByGame.get("iracing")?.get(ordinal);
  if (!assignment) {
    missingOrdinals.add(ordinal);
    return Promise.resolve(null);
  }

  const completed = completedMaps.get(assignment.layoutId);
  if (completed) return Promise.resolve(completed);
  const existing = pendingMaps.get(assignment.layoutId);
  if (existing) return existing;

  const pending = loadMap(assignment).then(
    (map) => {
      completedMaps.set(assignment.layoutId, map);
      pendingMaps.delete(assignment.layoutId);
      return map;
    },
    (error) => {
      pendingMaps.delete(assignment.layoutId);
      throw error;
    },
  );
  pendingMaps.set(assignment.layoutId, pending);
  return pending;
}

function nearestPointIndex(points: readonly { x: number; z: number }[], target: { x: number; z: number }): number {
  let nearest = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const distance = (points[index]!.x - target.x) ** 2 + (points[index]!.z - target.z) ** 2;
    if (distance < bestDistance) {
      nearest = index;
      bestDistance = distance;
    }
  }
  return nearest;
}

/** Validate every assigned iRacing layout and all four bundled SVG layers. */
export async function assertBundledIRacingSvgTrackMaps(): Promise<number> {
  const assignments = [...(getTrackRegistryIndexes().assignmentsByGame.get("iracing")?.values() ?? [])];
  for (const assignment of assignments) {
    const map = await getIRacingSvgTrackMap(assignment.trackOrdinal);
    if (!map || map.points.length !== 512) throw new Error(`Invalid bundled iRacing centerline for ${assignment.layoutId}`);
    const coordinates = [...map.points, ...map.labels, ...map.pitRoad.flat()];
    if (coordinates.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.z))) {
      throw new Error(`Non-finite bundled iRacing map coordinate for ${assignment.layoutId}`);
    }
    if (map.pitRoad.some((contour) => contour.length < 2)) {
      throw new Error(`Unusable bundled iRacing pit-road geometry for ${assignment.layoutId}`);
    }
    const turnPositions = map.labels
      .filter((label) => /^\d+$/.test(label.text))
      .map((label) => nearestPointIndex(map.points, label));
    if (turnPositions.some((position, index) => index > 0 && position < turnPositions[index - 1]!)) {
      throw new Error(`Unordered bundled iRacing turn labels for ${assignment.layoutId}`);
    }
  }
  return assignments.length;
}
