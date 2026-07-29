import { and, eq } from "drizzle-orm";
import { db } from "./index";
import { discoveredTracks } from "./schema";

export interface DiscoveredTrackRow {
  id: number;
  gameId: string;
  ordinal: number;
  name: string;
  createdAt: string;
}

/**
 * Persist a telemetry-provided track mapping. Native ordinals are stable, so
 * the first observed name remains authoritative for that game + ordinal.
 */
export async function registerDiscoveredTrack(
  gameId: string,
  ordinal: number,
  name: string,
): Promise<void> {
  await db
    .insert(discoveredTracks)
    .values({ gameId, ordinal, name })
    .onConflictDoNothing()
    .run();
}

export async function getDiscoveredTrackName(
  gameId: string,
  ordinal: number,
): Promise<string | undefined> {
  const row = await db
    .select({ name: discoveredTracks.name })
    .from(discoveredTracks)
    .where(and(eq(discoveredTracks.gameId, gameId), eq(discoveredTracks.ordinal, ordinal)))
    .get();
  return row?.name;
}

export async function listDiscoveredTracks(gameId?: string): Promise<DiscoveredTrackRow[]> {
  if (gameId) {
    return db.select().from(discoveredTracks).where(eq(discoveredTracks.gameId, gameId)).all();
  }
  return db.select().from(discoveredTracks).all();
}
