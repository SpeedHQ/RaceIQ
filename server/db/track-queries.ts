import { eq, and, inArray } from "drizzle-orm";
import { db, readDb } from "./index"
import { withDatabaseWrite } from "./write-coordination";
import { trackCorners, trackOutlines } from "./schema";
import type { GameId } from "@raceiq/shared/games/ids";
import type { Corner } from "../lap-analysis/corners"
import { accLegacyAlternatives } from "./acc-legacy-identity";

function trackKeys(trackId: string, gameId: GameId): string[] {
  return gameId === "acc" ? accLegacyAlternatives("track", trackId) : [trackId];
}

export async function getCorners(
  trackId: string,
  gameId: GameId,
  options?: { manualOnly?: boolean },
): Promise<Corner[]> {
  const rows = await readDb.select({
    trackId: trackCorners.trackId,
    isAuto: trackCorners.isAuto,
    cornerIndex: trackCorners.cornerIndex,
    label: trackCorners.label,
    distanceStart: trackCorners.distanceStart,
    distanceEnd: trackCorners.distanceEnd,
  })
    .from(trackCorners)
    .where(and(
      inArray(trackCorners.trackId, trackKeys(trackId, gameId)),
      eq(trackCorners.gameId, gameId),
    ))
    .orderBy(trackCorners.cornerIndex)
    .all();

  const identity = rows.some((row) => row.trackId === trackId) ? trackId :
    new Set(rows.map((row) => row.trackId)).size === 1 ? rows[0]?.trackId : undefined;
  return rows.filter((row) => row.trackId === identity && (!options?.manualOnly || !row.isAuto)).map((r) => ({
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
  await withDatabaseWrite(() => db.delete(trackCorners)
    .where(and(eq(trackCorners.trackId, trackId), eq(trackCorners.gameId, gameId)))
    .run());

  // Insert new corners
  if (corners.length > 0) {
    await withDatabaseWrite(() => db.insert(trackCorners)
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
      .run());
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
  const rows = await readDb.select({ trackId: trackOutlines.trackId, outline: trackOutlines.outline })
    .from(trackOutlines)
    .where(and(inArray(trackOutlines.trackId, trackKeys(trackId, gameId)), eq(trackOutlines.gameId, gameId)))
    .all();
  const row = rows.find((item) => item.trackId === trackId) ?? (rows.length === 1 ? rows[0] : undefined);
  if (!row) return null;
  const outlineBuf = row.outline as Buffer;
  const decompressed = Bun.gunzipSync(outlineBuf.buffer.slice(outlineBuf.byteOffset, outlineBuf.byteOffset + outlineBuf.byteLength) as ArrayBuffer);
  return JSON.parse(new TextDecoder().decode(decompressed));
}

