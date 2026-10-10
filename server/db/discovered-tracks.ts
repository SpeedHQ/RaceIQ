import { and, eq, sql } from "drizzle-orm";
import { injectDiscoveredAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { db } from "./index";
import { discoveredTracks } from "./schema";
import { normalizeSourceName } from "./discovered-cars";

export interface DiscoveredTrackRow {
  id: number;
  gameId: string;
  ordinal: number;
  name: string;
  sourceKey: string | null;
  trackName: string | null;
  trackConfiguration: string | null;
  createdAt: string;
}

export function acEvoTrackSourceKey(trackName: string, configuration: string): string {
  return JSON.stringify([normalizeSourceName(trackName), normalizeSourceName(configuration)]);
}

export async function registerDiscoveredTrack(gameId: string, ordinal: number, name: string): Promise<void> {
  await db.insert(discoveredTracks).values({ gameId, ordinal, name }).onConflictDoNothing().run();
}

const pending = new Map<string, Promise<number>>();
const allocationLocks = new Map<string, Promise<void>>();

export async function getOrCreateDiscoveredTrack(gameId: string, trackName: string, trackConfiguration: string): Promise<number> {
  if (gameId !== "ac-evo") throw new Error("Discovered track allocation is AC Evo source-identity only");
  if (!trackName.trim()) return -1;
  const sourceKey = acEvoTrackSourceKey(trackName, trackConfiguration);
  const pendingKey = JSON.stringify([gameId, sourceKey]);
  const active = pending.get(pendingKey);
  if (active) return active;
  const task = (async () => {
    const condition = and(eq(discoveredTracks.gameId, gameId), eq(discoveredTracks.sourceKey, sourceKey));
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    while (allocationLocks.has(gameId)) await allocationLocks.get(gameId);
    allocationLocks.set(gameId, lock);
    try {
      const found = await db.select().from(discoveredTracks).where(condition).get();
      if (found) {
        injectDiscoveredAcEvoTracks([found]);
        return found.ordinal;
      }
      const maxRow = await db.select({ maxOrdinal: sql<number | null>`max(${discoveredTracks.ordinal})` })
        .from(discoveredTracks).where(eq(discoveredTracks.gameId, gameId)).get();
      let ordinal = Math.max(99999, maxRow?.maxOrdinal ?? -1) + 1;
      for (;;) {
        try {
          const [created] = await db.insert(discoveredTracks).values({
            gameId, ordinal, name: trackName, sourceKey, trackName, trackConfiguration,
          }).returning();
          injectDiscoveredAcEvoTracks([created]);
          return ordinal;
        } catch (error) {
          const conflict = await db.select().from(discoveredTracks).where(condition).get();
          if (conflict) {
            injectDiscoveredAcEvoTracks([conflict]);
            return conflict.ordinal;
          }
          const ordinalConflict = await db.select({ id: discoveredTracks.id }).from(discoveredTracks)
            .where(and(eq(discoveredTracks.gameId, gameId), eq(discoveredTracks.ordinal, ordinal))).get();
          if (!ordinalConflict) throw error;
          ordinal += 1;
        }
      }
    } finally {
      allocationLocks.delete(gameId);
      release();
    }
  })();
  pending.set(pendingKey, task);
  try { return await task; } finally { pending.delete(pendingKey); }
}

export async function getDiscoveredTrackName(gameId: string, ordinal: number): Promise<string | undefined> {
  const row = await db.select({ name: discoveredTracks.name }).from(discoveredTracks)
    .where(and(eq(discoveredTracks.gameId, gameId), eq(discoveredTracks.ordinal, ordinal))).get();
  return row?.name;
}
export async function getDiscoveredAcEvoTrackSource(
  ordinal: number,
): Promise<{ trackName: string; trackConfiguration: string } | undefined> {
  const row = await db.select({
    trackName: discoveredTracks.trackName,
    trackConfiguration: discoveredTracks.trackConfiguration,
  }).from(discoveredTracks)
    .where(and(eq(discoveredTracks.gameId, "ac-evo"), eq(discoveredTracks.ordinal, ordinal))).get();
  if (!row?.trackName || row.trackConfiguration === null) return undefined;
  return { trackName: row.trackName, trackConfiguration: row.trackConfiguration };
}

export async function listDiscoveredTracks(gameId?: string): Promise<DiscoveredTrackRow[]> {
  if (gameId) return db.select().from(discoveredTracks).where(eq(discoveredTracks.gameId, gameId)).all();
  return db.select().from(discoveredTracks).all();
}
export async function hydrateDiscoveredAcEvoTracks(): Promise<void> {
  injectDiscoveredAcEvoTracks(await listDiscoveredTracks("ac-evo"));
}

