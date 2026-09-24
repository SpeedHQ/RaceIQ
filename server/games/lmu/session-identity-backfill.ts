import { existsSync, readFileSync } from "node:fs";
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { resolveLMUCar, resolveLMUTrack } from "../../../shared/games/lmu/catalog";
import { listDiscoveredCars } from "../../db/discovered-cars";
import { listDiscoveredTracks } from "../../db/discovered-tracks";
import { db } from "../../db/index";
import { sessions } from "../../db/schema";
import { decompressIfGzipSync, iterateSessionFrames } from "../../session-capture/framing";
import { identityFromLMUSourceFrame } from "./normalizer";
import { readLMUFramesFromBuffer } from "./recorder";
import { decodeLMUSourceFrame } from "./source-frame";

const BATCH_SIZE = 100;

export interface LMUSessionIdentityBackfillResult {
  resolved: number;
  alreadyFilled: number;
  unresolved: number;
  missingFile: number;
  malformedFile: number;
}

function identityFromCapture(path: string): ReturnType<typeof identityFromLMUSourceFrame> | null {
  const bytes = decompressIfGzipSync(Buffer.from(readFileSync(path)));
  const dumpFrames = readLMUFramesFromBuffer(bytes);
  const frames = dumpFrames.length > 0 ? dumpFrames : iterateSessionFrames(bytes);
  for (const rawFrame of frames) {
    const frame = decodeLMUSourceFrame(rawFrame);
    if (frame) return identityFromLMUSourceFrame(frame);
  }
  return null;
}

export async function backfillLMUSessionIdentity(): Promise<LMUSessionIdentityBackfillResult> {
  const result: LMUSessionIdentityBackfillResult = {
    resolved: 0,
    alreadyFilled: 0,
    unresolved: 0,
    missingFile: 0,
    malformedFile: 0,
  };
  const filled = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessions)
    .where(and(
      eq(sessions.gameId, "lmu"),
      isNotNull(sessions.carId),
      isNotNull(sessions.trackId),
    ))
    .get();
  result.alreadyFilled = Number(filled?.count ?? 0);

  const [legacyCars, legacyTracks] = await Promise.all([
    listDiscoveredCars("lmu"),
    listDiscoveredTracks("lmu"),
  ]);
  const legacyCarNames = new Map(legacyCars.map((row) => [row.ordinal, row.name]));
  const legacyTrackNames = new Map(legacyTracks.map((row) => [row.ordinal, row.name]));
  let afterId = 0;

  while (true) {
    const rows = await db
      .select({
        id: sessions.id,
        carOrdinal: sessions.carOrdinal,
        trackOrdinal: sessions.trackOrdinal,
        carId: sessions.carId,
        trackId: sessions.trackId,
        rawFile: sessions.rawFile,
      })
      .from(sessions)
      .where(and(
        eq(sessions.gameId, "lmu"),
        gt(sessions.id, afterId),
        or(isNull(sessions.carId), isNull(sessions.trackId)),
      ))
      .orderBy(asc(sessions.id))
      .limit(BATCH_SIZE)
      .all();
    if (rows.length === 0) break;

    for (const row of rows) {
      afterId = row.id;
      let captured: ReturnType<typeof identityFromLMUSourceFrame> | null = null;
      if (row.rawFile) {
        if (!existsSync(row.rawFile)) {
          result.missingFile++;
        } else {
          try {
            captured = identityFromCapture(row.rawFile);
            if (!captured) result.malformedFile++;
          } catch {
            result.malformedFile++;
          }
        }
      }

      const sourceCarId = captured?.carId ?? legacyCarNames.get(row.carOrdinal) ?? "";
      const sourceTrackId = captured?.trackId ?? legacyTrackNames.get(row.trackOrdinal) ?? "";
      const carId = row.carId
        ?? resolveLMUCar(sourceCarId, captured?.carName)?.id
        ?? sourceCarId;
      const trackId = row.trackId
        ?? resolveLMUTrack(sourceTrackId)?.id
        ?? sourceTrackId;

      const updates = {
        ...(row.carId === null && carId ? { carId } : {}),
        ...(row.trackId === null && trackId ? { trackId } : {}),
      };
      if (Object.keys(updates).length > 0) {
        await db.update(sessions).set(updates).where(eq(sessions.id, row.id)).run();
      }
      if (carId && trackId) result.resolved++;
      else result.unresolved++;
    }
  }

  return result;
}
