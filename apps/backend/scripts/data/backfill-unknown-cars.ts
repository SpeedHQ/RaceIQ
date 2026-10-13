/**
 * One-off backfill: find AC Evo sessions missing native car IDs, re-read raw
 * captures, extract first car model string, and register it in discovered cars.
 *
 * Safe to re-run: unresolved sessions remain unchanged and are logged.
 *
 * Usage: bun run apps/backend/scripts/data/backfill-unknown-cars.ts
 */
import { initServerGameAdapters } from "../../src/games/init";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
initServerGameAdapters(developmentReleaseFeatures);

import { and, eq } from "drizzle-orm";
import { db, initDb } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import { registerAcEvoCar } from "@raceiq/backend-core/db/discovered-cars";
import { META_FRAME_MAGIC } from "@raceiq/capture-formats/session/framing";
import { gunzipIfNeeded } from "@raceiq/tooling-data/lib/compression";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

const GAME_ID = "ac-evo";

/** Same framing as session-capture/recorder.ts and import-capture.ts: optional
 * 12-byte meta frame, then repeated [uint32 LE len][frame bytes]. */
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
  const buf = gunzipIfNeeded(raw);

  const serverGame = getServerGame(GAME_ID);
  const state = serverGame.createParserState?.() ?? null;

  for (const sourceFrame of iterateFrames(buf)) {
    let packet: TelemetryPacket | null = null;
    try {
      packet = serverGame.tryParse(sourceFrame, state);
    } catch {
      continue;
    }
    if (!packet) continue;

    const carModelName = (packet as TelemetryPacket & { carModelName?: string }).carModelName;
    if (carModelName) return carModelName;
    // Already resolved by the (now-updated) canonical car list — nothing to backfill.
    if (packet.carId !== "" && packet.carId !== "-1") return undefined;
  }
  return undefined;
}

async function main() {
  const unresolved = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.gameId, GAME_ID), eq(sessions.carId, "")))
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

    const carId = await registerAcEvoCar(carModelName);
    await db.update(sessions).set({ carId }).where(eq(sessions.id, session.id)).run();
    console.log(`[Backfill] Session ${session.id}: "${carModelName}" → native ID ${carId}`);
    fixed++;
  }

  console.log(`[Backfill] Done. Fixed ${fixed}, skipped ${skipped}, total ${unresolved.length}.`);
}

// DB setup is no longer implicit in the import — it must be awaited explicitly.
await initDb();
await main();
