import { gunzipBuffer } from "./framing";
import type { GameId } from "../../shared/games/ids";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { MOTEC_SESSION_SOURCE } from "@shared/integrations/motec";
import { decodeMotecSourceArchive, type MotecOffsetEncoding } from "../motec/source-archive";
import { parseLd } from "../motec/ld";
import { parseLdxBeacons } from "../motec/ldx";
import { resolveMotecTarget } from "../motec/targets";

export interface SessionCaptureSource { rawFile: string; source: string | null; gameId: GameId; carOrdinal: number; trackOrdinal: number; }
export type LoadedSessionSource =
  | { kind: "capture"; buffer: Buffer }
  | { kind: "packets"; packets: TelemetryPacket[]; offsetEncoding: MotecOffsetEncoding };
interface CacheEntry { size: number; mtimeMs: number; loaded: LoadedSessionSource }
const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 2;
export function clearRawFileCacheForTest(): void { cache.clear(); }
function key(source: SessionCaptureSource): string { return `${source.rawFile}\0${source.source ?? ""}\0${source.gameId}\0${source.carOrdinal}\0${source.trackOrdinal}`; }
export async function loadSessionSource(source: SessionCaptureSource): Promise<LoadedSessionSource> {
  const file = Bun.file(source.rawFile); const size = file.size; const mtimeMs = file.lastModified; const cacheKey = key(source);
  const hit = cache.get(cacheKey); if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.loaded;
  let loaded: LoadedSessionSource;
  const bytes = Buffer.from(await file.arrayBuffer());
  if (source.rawFile.endsWith(".motec.zip")) {
    if (source.source !== MOTEC_SESSION_SOURCE) throw new Error("Session source archive requires source 'motec'");
    const archive = decodeMotecSourceArchive(bytes); const log = parseLd(archive.ldBytes);
    const beacons = archive.ldxBytes ? parseLdxBeacons(archive.ldxBytes.toString("utf8")) : [];
    const target = resolveMotecTarget(source.gameId);
    const carTrack = target.resolveCarTrack(log, { carOrdinal: source.carOrdinal, trackOrdinal: source.trackOrdinal });
    loaded = { kind: "packets", packets: target.convert(log, beacons, carTrack).packets, offsetEncoding: archive.offsetEncoding };
  } else loaded = { kind: "capture", buffer: bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipBuffer(bytes) : bytes };
  cache.set(cacheKey, { size, mtimeMs, loaded }); while (cache.size > MAX_ENTRIES) { const oldest = cache.keys().next().value; if (oldest) cache.delete(oldest); }
  return loaded;
}
export async function loadSessionCapture(source: SessionCaptureSource): Promise<Buffer> {
  const loaded = await loadSessionSource(source); if (loaded.kind === "packets") throw new Error("Session source contains canonical packets, not BIN frames"); return loaded.buffer;
}
