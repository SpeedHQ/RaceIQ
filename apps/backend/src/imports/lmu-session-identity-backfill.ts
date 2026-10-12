import { existsSync, readFileSync } from "node:fs";
import { and, asc, eq, gt, ne, or, sql } from "drizzle-orm";
import { resolveLMUCar, resolveLMUTrack } from "@raceiq/game-lmu-metadata/catalog";
import { listDiscoveredCars } from "@raceiq/backend-core/db/discovered-cars";
import { listDiscoveredTracks } from "@raceiq/backend-core/db/discovered-tracks";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { decompressIfGzipSync, iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { identityFromLMUSourceFrame } from "@raceiq/game-lmu/normalizer";
import { readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump-decoder";
import { decodeLMUSourceFrame } from "@raceiq/capture-formats/lmu/source-frame";

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
      ne(sessions.carId, ""),
      ne(sessions.trackId, ""),
      sql`NOT (${sessions.carId} GLOB '[0-9]*' AND ${sessions.carId} NOT GLOB '*[^0-9]*')`,
      sql`NOT (${sessions.trackId} GLOB '[0-9]*' AND ${sessions.trackId} NOT GLOB '*[^0-9]*')`,
    ))
    .get();
  result.alreadyFilled = Number(filled?.count ?? 0);

  const [legacyCars, legacyTracks] = await Promise.all([
    listDiscoveredCars("lmu"),
    listDiscoveredTracks("lmu"),
  ]);
  const legacyCarNames = new Map(legacyCars.map((row) => [row.carId, row.name]));
  const legacyTrackNames = new Map(legacyTracks.map((row) => [row.trackId, row.name]));
  let afterId = 0;

  while (true) {
    const rows = await db
      .select({
        id: sessions.id,
        carId: sessions.carId,
        trackId: sessions.trackId,
        rawFile: sessions.rawFile,
      })
      .from(sessions)
      .where(and(
        eq(sessions.gameId, "lmu"),
        gt(sessions.id, afterId),
        or(eq(sessions.carId, ""), eq(sessions.trackId, ""),
          sql`(${sessions.carId} GLOB '[0-9]*' AND ${sessions.carId} NOT GLOB '*[^0-9]*')`,
          sql`(${sessions.trackId} GLOB '[0-9]*' AND ${sessions.trackId} NOT GLOB '*[^0-9]*')`),
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

      const legacyCar = /^\d+$/.test(row.carId);
      const legacyTrack = /^\d+$/.test(row.trackId);
      const sourceCarId = captured?.carId ?? legacyCarNames.get(row.carId) ?? "";
      const sourceTrackId = captured?.trackId ?? legacyTrackNames.get(row.trackId) ?? "";
      const carId = row.carId && !legacyCar ? row.carId
        : resolveLMUCar(sourceCarId, captured?.carName)?.id ?? sourceCarId;
      const trackId = row.trackId && !legacyTrack ? row.trackId
        : resolveLMUTrack(sourceTrackId)?.id ?? sourceTrackId;

      const updates = {
        ...((!row.carId || legacyCar) && carId ? { carId } : {}),
        ...((!row.trackId || legacyTrack) && trackId ? { trackId } : {}),
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
