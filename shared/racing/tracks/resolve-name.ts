import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tryGetGame } from "@shared/games/registry";
import { SHARED_DIR, USER_TRACKS_DIR } from "@shared/platform/runtime/data-paths";
import { getAccSharedTrackName } from "./catalogs/acc";
import { getAcEvoSharedTrackName } from "./catalogs/ac-evo";
import { getF1TrackInfo } from "./catalogs/f1";
import { getFmBundledTrackName, getFmTrackName } from "./catalogs/fm";
import { getIRacingSharedTrackName } from "./catalogs/iracing";
import { GameIdSchema } from "../../games/ids";
import { getTrackRegistry } from "./registry";

export interface TrackPoint {
  x: number;
  z: number;
}

const ACC_2019_VARIANT: Record<number, number> = {
  11: 0,
  12: 1,
  13: 2,
  14: 3,
  15: 4,
  16: 5,
  17: 6,
  18: 7,
  19: 8,
  20: 9,
  21: 10,
};

function readDataFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
interface ConfiguredNameRow {
  venuePath: string;
  layoutName: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
}

function configuredTrackName(ordinal: number, gameId: string | undefined): string | null {
  const parsedGameId = GameIdSchema.safeParse(gameId);
  if (!parsedGameId.success) return null;
  const database = getTrackRegistry();
  const row = database.query(`
    SELECT l.venue_path AS venuePath, l.name AS layoutName,
           gt.confirmed_at AS confirmedAt, gt.confirmed_by AS confirmedBy
      FROM game_tracks gt
      JOIN layouts l ON l.canonical_id = gt.layout_id
     WHERE gt.game_id = ? AND gt.track_ordinal = ?
  `).get(parsedGameId.data, ordinal) as ConfiguredNameRow | null;
  if (!row?.confirmedAt || !row.confirmedBy) return null;
  const paths = row.venuePath.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));
  const names = paths.map((path) => {
    const venue = database.query("SELECT name FROM venue_nodes WHERE path = ?").get(path) as { name: string } | null;
    if (!venue) throw new Error(`Track registry venue hierarchy is incomplete for ${row.venuePath}`);
    return venue.name;
  });
  return [...names, row.layoutName].join(" — ");
}


/** Resolve confirmed canonical identity first, then registered game catalog. */
export function resolveTrackName(ordinal: number, gameId?: string): string {
  const canonical = configuredTrackName(ordinal, gameId);
  if (canonical) return canonical;
  const adapter = gameId ? tryGetGame(gameId) : undefined;
  return adapter?.getTrackName(ordinal) ?? getFmTrackName(ordinal);
}

/** Resolve ordinal to bundled geometry file prefix. */
export function getBundledTrackName(gameId: string, ordinal: number): string | undefined {
  if (gameId === "f1-2025") return getF1TrackInfo(ordinal)?.commonTrackName || undefined;
  if (gameId === "iracing") return getIRacingSharedTrackName(ordinal);
  if (gameId === "fm-2023") return getFmBundledTrackName(ordinal);
  if (gameId === "acc") {
    const baseOrdinal = ACC_2019_VARIANT[ordinal] ?? ordinal;
    return getAccSharedTrackName(baseOrdinal);
  }
  if (gameId === "ac-evo") return getAcEvoSharedTrackName(ordinal);
  return undefined;
}

export function computedAverageFileName(gameId: string, ordinal: number): string {
  const name = getBundledTrackName(gameId, ordinal);
  return name ? `${name}-computed-average` : `${ordinal}-computed-average`;
}

export function bundledTrackDir(gameId: string): string {
  return resolve(SHARED_DIR, "tracks", gameId);
}

export function toBundledPath(gameId: string, relativePath: string): string | null {
  const normalized = relativePath.startsWith("extracted/")
    ? relativePath.slice("extracted/".length)
    : relativePath;
  const match = normalized.match(/^(\w+)-(\d+)\.(json|csv)$/);
  if (!match) return normalized;
  const name = getBundledTrackName(gameId, Number.parseInt(match[2], 10));
  if (!name) return null;
  const kind = match[1] === "recorded" ? "centerline" : match[1];
  return `${name}-${kind}.${match[3]}`;
}

export function readUserOrBundled(gameId: string, relativePath: string): string | null {
  const userResult = readDataFile(resolve(USER_TRACKS_DIR, gameId, relativePath));
  if (userResult !== null) return userResult;
  const bundledPath = toBundledPath(gameId, relativePath);
  return bundledPath ? readDataFile(resolve(bundledTrackDir(gameId), bundledPath)) : null;
}

const bundledPointCache = new Map<string, TrackPoint[] | null>();

export function loadBundledPointCsv(
  ordinal: number,
  gameId: string,
  suffix: "centerline" | "raceline",
): TrackPoint[] | null {
  const key = `${suffix}:${gameId}:${ordinal}`;
  const cached = bundledPointCache.get(key);
  if (cached !== undefined) return cached;

  const name = getBundledTrackName(gameId, ordinal);
  if (!name) {
    bundledPointCache.set(key, null);
    return null;
  }

  let content = readDataFile(resolve(bundledTrackDir(gameId), `${name}-${suffix}.csv`));
  if (!content && gameId === "ac-evo") {
    content = readDataFile(resolve(bundledTrackDir("acc"), `${name}-${suffix}.csv`));
  }
  if (!content) {
    bundledPointCache.set(key, null);
    return null;
  }

  try {
    const points = content
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const [x, z] = line.split(",").map(Number);
        return { x, z };
      });
    const result = points.length > 10 ? points : null;
    bundledPointCache.set(key, result);
    return result;
  } catch {
    bundledPointCache.set(key, null);
    return null;
  }
}
