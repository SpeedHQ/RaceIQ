import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { GameId } from "../../../shared/games/ids";
import type { TelemetryPacket } from "../../../shared/telemetry/types";
import { getServerGame } from "../../../server/games/registry";
import { META_FRAME_MAGIC } from "../../../server/session-capture/framing"
import { ensureInit } from "./parse-dump";

/**
 * Read every packet out of a recorded session `.bin` / `.bin.gz` artifact.
 *
 * `test/support/recordings/parse-dump.ts` handles the older per-game dump formats; this
 * reads the length-prefixed session-bin container (with `META_FRAME_MAGIC`
 * sidecar frames interleaved) that `server/session-capture/recorder.ts` writes today.
 */
export function readSessionPackets(filePath: string, gameId: GameId): TelemetryPacket[] {
  ensureInit();

  const raw = readFileSync(filePath);
  const buf = filePath.endsWith(".gz") ? Buffer.from(gunzipSync(raw)) : raw;

  const game = getServerGame(gameId);
  const state = game.createParserState?.() ?? null;
  const packets: TelemetryPacket[] = [];

  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    // Meta frames are `[magic:u32][len:u32][payload]` — skip, they are not telemetry.
    if (length === META_FRAME_MAGIC) {
      if (offset + 8 > buf.length) break;
      offset += 8 + buf.readUInt32LE(offset + 4);
      continue;
    }
    offset += 4;
    if (length === 0 || offset + length > buf.length) break;
    const packet = game.tryParse(buf.subarray(offset, offset + length), state);
    offset += length;
    if (packet) packets.push(packet);
  }

  return packets;
}
