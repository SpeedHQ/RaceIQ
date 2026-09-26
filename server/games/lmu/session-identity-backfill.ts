import { existsSync, readFileSync } from "node:fs";
import { and, asc, eq, gt } from "drizzle-orm";
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
        carId: sessions.carId,
        trackId: sessions.trackId,
        rawFile: sessions.rawFile,
      })
      .from(sessions)
      .where(and(eq(sessions.gameId, "lmu"), gt(sessions.id, afterId)))
      .orderBy(asc(sessions.id))
      .limit(BATCH_SIZE)
      .all();
    if (rows.length === 0) break;

    for (const row of rows) {
      afterId = row.id;
      const legacyCar = !row.carId || /^-?\d+$/.test(row.carId);
      const legacyTrack = !row.trackId || /^-?\d+$/.test(row.trackId);
      if (!legacyCar && !legacyTrack) {
        result.alreadyFilled++;
        continue;
      }
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

      const sourceCarId = captured?.carId ?? legacyCarNames.get(Number(row.carId)) ?? "";
      const sourceTrackId = captured?.trackId ?? legacyTrackNames.get(Number(row.trackId)) ?? "";
      const resolvedCar = legacyCar ? resolveLMUCar(sourceCarId, captured?.carName)?.id ?? sourceCarId : row.carId;
      const resolvedTrack = legacyTrack ? resolveLMUTrack(sourceTrackId)?.id ?? sourceTrackId : row.trackId;
      const updates = {
        ...(legacyCar && resolvedCar && resolvedCar !== row.carId ? { carId: resolvedCar } : {}),
        ...(legacyTrack && resolvedTrack && resolvedTrack !== row.trackId ? { trackId: resolvedTrack } : {}),
      };
      if (Object.keys(updates).length > 0) {
        await db.update(sessions).set(updates).where(eq(sessions.id, row.id)).run();
      }
      if (Object.keys(updates).length > 0) result.resolved++;
      else result.unresolved++;
    }
  }

  return result;
}
