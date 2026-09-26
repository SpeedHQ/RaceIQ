import { eq, and } from "drizzle-orm";
import { db } from "./index";
import { trackCorners, trackOutlines } from "./schema";
import type { GameId } from "../../shared/games/ids";
import type { Corner } from "../lap-analysis/corners"

export async function getCorners(trackId: string, gameId: GameId): Promise<Corner[]> {
  const rows = await db
    .select({
      cornerIndex: trackCorners.cornerIndex,
      label: trackCorners.label,
      distanceStart: trackCorners.distanceStart,
      distanceEnd: trackCorners.distanceEnd,
    })
    .from(trackCorners)
    .where(and(eq(trackCorners.trackId, trackId), eq(trackCorners.gameId, gameId)))
    .orderBy(trackCorners.cornerIndex)
    .all();

  return rows.map((r) => ({
    index: r.cornerIndex,
    label: r.label,
    distanceStart: r.distanceStart,
    distanceEnd: r.distanceEnd,
  }));
}

/**
 * Save/update corner definitions for a track.
 * Replaces all existing corners for that track.
 */

export async function saveCorners(
  trackId: string,
  corners: Corner[],
  gameId: GameId,
  isAuto: boolean = false
): Promise<void> {
  await db.delete(trackCorners)
    .where(and(eq(trackCorners.trackId, trackId), eq(trackCorners.gameId, gameId)))
    .run();

  if (corners.length > 0) {
    await db.insert(trackCorners)
      .values(
        corners.map((c) => ({
          trackId,
          cornerIndex: c.index,
          label: c.label,
          distanceStart: c.distanceStart,
          distanceEnd: c.distanceEnd,
          isAuto,
          gameId,
        }))
      )
      .run();
  }
}

/**
 * Find the first lap for a given track (to use for auto-detection).
 * Returns the lap ID or null if no laps exist for this track.
 */

export async function getTrackOutline(
  trackId: string,
  gameId: GameId
): Promise<{ x: number; z: number; speed: number }[] | null> {
  const row = await db
    .select({ outline: trackOutlines.outline })
    .from(trackOutlines)
    .where(and(eq(trackOutlines.trackId, trackId), eq(trackOutlines.gameId, gameId)))
    .get();

  if (!row) return null;
  const outlineBuf = row.outline as Buffer;
  const decompressed = Bun.gunzipSync(outlineBuf.buffer.slice(outlineBuf.byteOffset, outlineBuf.byteOffset + outlineBuf.byteLength) as ArrayBuffer);
  return JSON.parse(new TextDecoder().decode(decompressed));
}

