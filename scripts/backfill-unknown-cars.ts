/**
 * One-off backfill: find AC Evo sessions stuck at car_ordinal = -1 (recorded
 * before the discovered_cars feature existed, or before an unresolved car's
 * model string made it into a packet the old parser kept), re-read their raw
 * capture files, extract the first resolvable car model string, register it
 * in discovered_cars, and patch the session's car_ordinal.
 *
 * Safe to re-run: sessions that still can't be resolved (corrupt/truncated
 * raw file, or the car never sent a model string) are left at -1 and logged.
 *
 * Usage: bun run scripts/backfill-unknown-cars.ts
 */
import { initServerGameAdapters } from "../server/games/init";
initServerGameAdapters();

import { gunzipSync } from "zlib";
import { eq, and } from "drizzle-orm";
import { db, initDb } from "../server/db/index";
import { sessions } from "../server/db/schema";
import { getServerGame } from "../server/games/registry";
import { getOrCreateDiscoveredCar } from "../server/db/discovered-cars";
import { META_FRAME_MAGIC } from "../server/udp-recorder";
import type { TelemetryPacket } from "../shared/types";

const GAME_ID = "ac-evo";

function decompressIfGz(bytes: Buffer): Buffer {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return Buffer.from(gunzipSync(bytes));
  }
  return bytes;
}

/** Same framing as udp-recorder.ts / import-session-bin.ts: optional 12-byte
 * meta frame, then repeated [uint32 LE len][frame bytes]. */
function* iterateFrames(buf: Buffer): Generator<Buffer> {
  let offset = 0;
  if (buf.length >= 4 && buf.readUInt32LE(0) === META_FRAME_MAGIC) offset = 12;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (len <= 0 || offset + len > buf.length) break;
    yield buf.subarray(offset, offset + len);
    offset += len;
  }
}

async function resolveCarModelFromRawFile(rawFile: string): Promise<string | undefined> {
  const raw = Buffer.from(await Bun.file(rawFile).arrayBuffer());
  const buf = decompressIfGz(raw);

  const serverGame = getServerGame(GAME_ID);
  const state = serverGame.createParserState?.() ?? null;

  for (const frameBuf of iterateFrames(buf)) {
    let packet: TelemetryPacket | null = null;
    try {
      packet = serverGame.tryParse(frameBuf, state);
    } catch {
      continue;
    }
    if (!packet) continue;

    const carModelName = (packet as TelemetryPacket & { carModelName?: string }).carModelName;
    if (carModelName) return carModelName;
    // Already resolved by the (now-updated) canonical car list — nothing to backfill.
    if (packet.CarOrdinal >= 0) return undefined;
  }
  return undefined;
}

async function main() {
  const unresolved = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.gameId, GAME_ID), eq(sessions.carOrdinal, -1)))
    .all();

  console.log(`[Backfill] Found ${unresolved.length} unresolved AC Evo session(s).`);

  let fixed = 0;
  let skipped = 0;

  for (const session of unresolved) {
    if (!session.rawFile) {
      console.warn(`[Backfill] Session ${session.id}: no raw_file on record, skipping.`);
      skipped++;
      continue;
    }

    let carModelName: string | undefined;
    try {
      carModelName = await resolveCarModelFromRawFile(session.rawFile);
    } catch (err) {
      console.warn(`[Backfill] Session ${session.id}: failed to read "${session.rawFile}": ${(err as Error).message}`);
      skipped++;
      continue;
    }

    if (!carModelName) {
      console.warn(`[Backfill] Session ${session.id}: could not extract a car model from "${session.rawFile}".`);
      skipped++;
      continue;
    }

    const ordinal = await getOrCreateDiscoveredCar(GAME_ID, carModelName);
    await db.update(sessions).set({ carOrdinal: ordinal }).where(eq(sessions.id, session.id)).run();
    console.log(`[Backfill] Session ${session.id}: "${carModelName}" → ordinal ${ordinal}`);
    fixed++;
  }

  console.log(`[Backfill] Done. Fixed ${fixed}, skipped ${skipped}, total ${unresolved.length}.`);
}

// DB setup is no longer implicit in the import — it must be awaited explicitly.
await initDb();
await main();
