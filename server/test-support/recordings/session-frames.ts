import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { ServerGameAdapter } from "../../games/types";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { META_FRAME_MAGIC } from "@raceiq/capture-formats/session/framing"

/**
 * Read every packet out of a recorded session `.bin` / `.bin.gz` artifact.
 *
 * `test/support/recordings/parse-dump.ts` handles the older per-game dump formats; this
 * reads the length-prefixed session-bin container (with `META_FRAME_MAGIC`
 * sidecar frames interleaved) that `packages/capture-formats/src/session/recorder.ts` writes today.
 */
export function readSessionPackets(filePath: string, adapter: ServerGameAdapter): TelemetryPacket[] {
  const raw = readFileSync(filePath);
  const buf = filePath.endsWith(".gz") ? Buffer.from(gunzipSync(raw)) : raw;

  const state = adapter.createParserState?.() ?? null;
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
    const packet = adapter.tryParse(buf.subarray(offset, offset + length), state);
    offset += length;
    if (packet) packets.push(packet);
  }

  return packets;
}
