import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { db, client, initDb } from "../../server/db/index";
import { importSessionBin } from "../../server/session-capture/import-capture";
import { importSessionFrames } from "../../server/session-capture/import-pipeline";
import { LMU_DUMP_MAGIC, LMU_DUMP_VERSION } from "../../server/games/lmu/recorder";
import { LMU_MAX_SOURCE_FRAME_SIZE } from "../../server/games/lmu/source-frame";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { developmentReleaseFeatures } from "../release/development-release-features";
import { profiles, sessions } from "../../server/db/schema";
import { eq, inArray } from "drizzle-orm";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { seedIRacingSession } from "./seed-db-iracing";
import { assertSafeTarget, seedRowCount } from "./seed-db-safety";
import { insertDemoRows, markOnboardingComplete } from "./seed-db-demo";
import { cleanDatabase, removeSeedData } from "./seed-db-reset";
import { FIXTURES, PROFILE_NAME, parseOptions, SEED_MARKER } from "./seed-db-options";
import { combineRecordingParts } from "../lib/combine-recording-parts";

async function* streamLMUSeedFrames(path: string): AsyncGenerator<Buffer> {
  const source = createReadStream(path);
  const stream = path.toLowerCase().endsWith(".gz") ? source.pipe(createGunzip({ chunkSize: 512 * 1024 })) : source;
  let pending = Buffer.alloc(0);
  let headerRead = false;
  let count = 0;
  let declaredCount = 0;
  let offset = 0;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (!headerRead) {
      if (pending.length < 16) continue;
      if (!pending.subarray(0, 8).equals(LMU_DUMP_MAGIC) ||
          pending.readUInt32LE(8) !== LMU_DUMP_VERSION) {
        throw new Error(`Invalid LMU seed recording: ${path}`);
      }
      declaredCount = pending.readUInt32LE(12);
      headerRead = true;
      offset = 16;
    }
    while (offset + 5 <= pending.length && (!declaredCount || count < declaredCount)) {
      const type = pending.readUInt8(offset);
      const size = pending.readUInt32LE(offset + 1);
      if (type !== 0 || size === 0 || size > LMU_MAX_SOURCE_FRAME_SIZE) {
        throw new Error(`Invalid LMU seed frame ${count}`);
      }
      if (offset + 5 + size > pending.length) break;
      offset += 5;
      const frame = pending.subarray(offset, offset + size);
      offset += size;
      count++;
      yield frame;
    }
    pending = pending.subarray(offset);
    offset = 0;
  }
  if (!headerRead || (declaredCount && count < declaredCount)) {
    throw new Error(`Truncated LMU seed recording: ${path}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  await initDb();
  initGameAdapters(developmentReleaseFeatures);
  initServerGameAdapters(developmentReleaseFeatures);
  if (options.clean) {
    await cleanDatabase();
  } else {
    await assertSafeTarget(options.force);
  }
  if (options.reset) await removeSeedData();
  if (await seedRowCount()) {
    markOnboardingComplete();
    console.log("[DB Seed] Seed data already exists; nothing to do.");
    return;
  }

  const profile = await db.insert(profiles).values({ name: PROFILE_NAME }).returning({ id: profiles.id }).get();
  const importedLapIds: number[] = [];
  for (const game of options.games) {
    const fixtures = options.fixtures ?? FIXTURES[game];
    for (const fixture of fixtures) {
      const partMatch = /^(.*)\.part(\d+)$/i.exec(fixture);
      if (partMatch && Number(partMatch[2]) !== 1) continue;
      const partPaths = (partMatch
        ? fixtures.filter((path) => {
            const match = /^(.*)\.part\d+$/i.exec(path);
            return match?.[1]?.toLowerCase() === partMatch[1]!.toLowerCase();
          })
        : [fixture]
      ).map((path) => resolve(import.meta.dir, "../..", path));
      for (const partPath of partPaths) {
        if (!existsSync(partPath)) throw new Error(`Missing seed fixture: ${partPath}`);
      }
      const combined = partMatch ? await combineRecordingParts(partPaths) : null;
      const fixturePath = combined?.path ?? partPaths[0]!;
      try {
        if (game === "iracing") {
          await seedIRacingSession(fixturePath);
          continue;
        }
        const existingSessionIds = new Set(
          (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all()).map((row) => row.id),
        );
        const result = game === "lmu"
          ? await importSessionFrames(streamLMUSeedFrames(fixturePath), game, { notifyDriverProfile: false })
          : await importSessionBin(readFileSync(fixturePath), game, { notifyDriverProfile: false });
        const seededSessionIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all())
          .map((row) => row.id)
          .filter((id) => !existingSessionIds.has(id));
        if (seededSessionIds.length === 0) {
          throw new Error(`No ${game} telemetry imported from ${fixturePath}`);
        }
        await db.update(sessions).set({ notes: SEED_MARKER, source: "seed" }).where(inArray(sessions.id, seededSessionIds)).run();
        importedLapIds.push(...result.laps.filter((lap) => lap.isValid).map((lap) => lap.lapId));
        console.log(`[DB Seed] ${game}: ${result.laps.length} laps from ${fixture}`);
      } finally {
        combined?.cleanup();
      }
    }
  }
  if (importedLapIds.length) await insertDemoRows(profile.id, importedLapIds);
  markOnboardingComplete();
  console.log(`[DB Seed] Complete: ${importedLapIds.length} valid laps, ${options.games.join(", ")}.`);
}

try {
  await main();
} finally {
  stopMaintenanceTasks();
  client.close();
}
