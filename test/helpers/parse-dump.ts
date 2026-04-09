import type { GameId } from "../../shared/types";
import type { CapturedLap } from "../../server/pipeline-adapters";
import { CapturingDbAdapter, NullWsAdapter } from "../../server/pipeline-adapters";
import { Pipeline } from "../../server/pipeline";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getAllServerGames } from "../../server/games/registry";
import { readUdpDump } from "./recording";
import { readAccFrames } from "../../server/games/acc/recorder";
import { parseAccBuffers } from "../../server/games/acc/parser";

let _initialized = false;
function ensureInit(): void {
  if (_initialized) return;
  initGameAdapters();
  initServerGameAdapters();
  _initialized = true;
}

/**
 * Feed a recorded dump through the full server pipeline and return all captured laps.
 * Uses CapturingDbAdapter (no real DB writes) and NullWsAdapter (no WebSocket).
 *
 * @param gameId   The game the dump was recorded for
 * @param dumpPath Path to the dump.bin file
 */
export async function parseDump(
  gameId: GameId,
  dumpPath: string
): Promise<CapturedLap[]> {
  ensureInit();

  const db = new CapturingDbAdapter();
  const ws = new NullWsAdapter();
  const pipeline = new Pipeline(db, ws);

  if (gameId === "acc") {
    let frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[];
    try {
      frames = readAccFrames(dumpPath);
    } catch {
      return [];
    }
    for (const frame of frames) {
      const packet = parseAccBuffers(frame.physics, frame.graphics, frame.staticData, {});
      if (packet) await pipeline.processPacket(packet);
    }
  } else {
    let buffers: Buffer[];
    try {
      buffers = readUdpDump(dumpPath);
    } catch {
      return [];
    }

    if (buffers.length === 0) return [];

    const serverAdapter = getAllServerGames().find((a) => a.canHandle(buffers[0]));
    if (!serverAdapter) return [];

    const parserState = serverAdapter.createParserState?.() ?? null;
    for (const buf of buffers) {
      const packet = serverAdapter.tryParse(buf, parserState);
      if (packet) await pipeline.processPacket(packet);
    }
  }

  // Flush deferred insertLap calls (lap-detector uses setTimeout(..., 0))
  await new Promise<void>((r) => setTimeout(r, 0));

  return db.laps;
}
