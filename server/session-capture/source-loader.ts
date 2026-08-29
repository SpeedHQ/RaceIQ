import { gunzipBuffer } from "./framing";
import type { GameId } from "../../shared/games/ids";
import { MOTEC_SESSION_SOURCE } from "@shared/integrations/motec";
import { decodeMotecSourceArchive } from "../motec/source-archive";
import { parseLd } from "../motec/ld";
import { parseLdxBeacons } from "../motec/ldx";
import { resolveMotecTarget } from "../motec/targets";

export interface SessionCaptureSource {
  rawFile: string;
  source: string | null;
  gameId: GameId;
  carOrdinal: number;
  trackOrdinal: number;
}

interface CacheEntry { size: number; mtimeMs: number; buf: Buffer }
const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 2;

export function clearRawFileCacheForTest(): void { cache.clear(); }

function key(source: SessionCaptureSource): string {
  return `${source.rawFile}\0${source.source ?? ""}\0${source.gameId}\0${source.carOrdinal}\0${source.trackOrdinal}`;
}

export async function loadSessionCapture(source: SessionCaptureSource): Promise<Buffer> {
  const file = Bun.file(source.rawFile);
  const size = file.size;
  const mtimeMs = file.lastModified;
  const cacheKey = key(source);
  const hit = cache.get(cacheKey);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.buf;
  }

  let buf: Buffer<ArrayBufferLike> = Buffer.from(await file.arrayBuffer());
  if (source.rawFile.endsWith(".motec.zip")) {
    if (source.source !== MOTEC_SESSION_SOURCE) {
      throw new Error("Session source archive requires source 'motec'");
    }
    const archive = decodeMotecSourceArchive(buf);
    const log = parseLd(archive.ldBytes);
    const beacons = archive.ldxBytes
      ? parseLdxBeacons(archive.ldxBytes.toString("utf8"))
      : [];
    const target = resolveMotecTarget(source.gameId);
    buf = target.synthesize(log, beacons, {
      carOrdinal: source.carOrdinal,
      trackOrdinal: source.trackOrdinal,
    }).bin;
  } else if (source.rawFile.endsWith(".gz")) {
    buf = await gunzipBuffer(buf);
  }

  cache.set(cacheKey, { size, mtimeMs, buf });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return buf;
}
