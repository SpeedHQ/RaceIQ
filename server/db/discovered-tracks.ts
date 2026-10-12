import { and, eq } from "drizzle-orm";
import { injectDiscoveredAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { acEvoTrackId } from "@raceiq/game-ac-evo-metadata/identity";
import { db } from "./index";
import { discoveredTracks } from "./schema";

export interface DiscoveredTrackRow {
  id: number;
  gameId: string;
  trackId: string;
  name: string;
  trackName: string | null;
  trackConfiguration: string | null;
  createdAt: string;
}

export async function registerDiscoveredTrack(gameId: string, trackId: string, name: string): Promise<void> {
  if (gameId === "ac-evo") {
    await registerAcEvoTrack(name, "");
    return;
  }
  await db.insert(discoveredTracks).values({ gameId, trackId, name }).onConflictDoNothing().run();
}

export async function registerAcEvoTrack(trackName: string, trackConfiguration: string): Promise<string> {
  if (!trackName.trim()) return "";
  const name = trackName.trim();
  const configuration = trackConfiguration.trim();
  const id = acEvoTrackId(name, configuration);
  await db.insert(discoveredTracks).values({
    gameId: "ac-evo", trackId: id, name,
    trackName: name, trackConfiguration: configuration,
  }).onConflictDoNothing().run();
  injectDiscoveredAcEvoTracks([{ id, name, trackName: name, trackConfiguration: configuration }]);
  return id;
}

export async function getDiscoveredTrackName(gameId: string, trackId: string): Promise<string | undefined> {
  const row = await db.select({ name: discoveredTracks.name }).from(discoveredTracks)
    .where(and(eq(discoveredTracks.gameId, gameId), eq(discoveredTracks.trackId, trackId))).get();
  return row?.name;
}
export async function getDiscoveredAcEvoTrackSource(
  trackId: string,
): Promise<{ trackName: string; trackConfiguration: string } | undefined> {
  const row = await db.select({
    trackName: discoveredTracks.trackName,
    trackConfiguration: discoveredTracks.trackConfiguration,
  }).from(discoveredTracks)
    .where(and(eq(discoveredTracks.gameId, "ac-evo"), eq(discoveredTracks.trackId, trackId))).get();
  if (!row?.trackName || row.trackConfiguration === null) return undefined;
  return { trackName: row.trackName, trackConfiguration: row.trackConfiguration };
}

export async function listDiscoveredTracks(gameId?: string): Promise<DiscoveredTrackRow[]> {
  if (gameId) return db.select().from(discoveredTracks).where(eq(discoveredTracks.gameId, gameId)).all();
  return db.select().from(discoveredTracks).all();
}
export async function hydrateDiscoveredAcEvoTracks(): Promise<void> {
  injectDiscoveredAcEvoTracks((await listDiscoveredTracks("ac-evo")).map((row) => ({
    id: row.trackId,
    name: row.name, trackName: row.trackName, trackConfiguration: row.trackConfiguration,
  })));
}

