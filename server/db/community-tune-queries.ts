import { eq } from "drizzle-orm";
import { db } from "./index";
import { communityTunes } from "./schema";

export interface CommunityTuneRow {
  id: string;
  gameId: string;
  carOrdinal: number;
  trackOrdinal: number | null;
  name: string;
  author: string;
  category: string;
  description: string;
  sourceName: string;
  /** JSON-serialized TuneSettings */
  settings: string;
}

/** All community tunes for a game (raw rows; `settings` is still JSON text). */
export async function getCommunityTunes(gameId: string) {
  return await db
    .select()
    .from(communityTunes)
    .where(eq(communityTunes.gameId, gameId))
    .all();
}

/** Single community tune by its `community-<messageId>` id. */
export async function getCommunityTuneById(id: string) {
  return (
    (await db.select().from(communityTunes).where(eq(communityTunes.id, id)).get()) ??
    null
  );
}

/**
 * Transactional replace-all for one game: delete every row for `gameId`, then
 * insert `rows`. Either the whole new set lands or the old set is preserved —
 * a failure mid-way rolls back and the persistent cache is untouched.
 */
export async function replaceCommunityTunes(
  gameId: string,
  rows: CommunityTuneRow[],
): Promise<number> {
  return await db.transaction(async (tx) => {
    await tx.delete(communityTunes).where(eq(communityTunes.gameId, gameId));
    for (const row of rows) {
      await tx.insert(communityTunes).values({
        id: row.id,
        gameId: row.gameId,
        carOrdinal: row.carOrdinal,
        trackOrdinal: row.trackOrdinal,
        name: row.name,
        author: row.author,
        category: row.category,
        description: row.description,
        sourceName: row.sourceName,
        settings: row.settings,
      });
    }
    return rows.length;
  });
}
