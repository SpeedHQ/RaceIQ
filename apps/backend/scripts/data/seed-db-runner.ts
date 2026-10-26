import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { db, closeDb, initDb } from "@raceiq/backend-core/db/index";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { link, mkdir, unlink } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { commitStagedIbt, stageIbtUpload } from "../../src/imports/iracing-ibt";
import { importSessionBin } from "@raceiq/backend-core/session-capture/import-capture";
import { importSessionFrames } from "@raceiq/backend-core/session-capture/import-pipeline";
import {
  decompressIfGzipSync,
  iterateSessionCaptureRecords,
  SESSION_SEGMENT_BOUNDARY,
  SESSION_SEGMENT_CONTEXT,
  SESSION_SEGMENT_CONTEXT_END,
} from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorderAdapter } from "@raceiq/backend-core/telemetry/pipeline-ports";
import { convertSeedFramesToSparse } from "@raceiq/tooling-data/data/seed-capture-conversion";
import { LMU_DUMP_MAGIC, LMU_DUMP_VERSION } from "@raceiq/capture-formats/lmu/dump-decoder";
import { decodeLMUSourceFrame, LMU_MAX_SOURCE_FRAME_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { readAMS2DumpFrames } from "@raceiq/capture-formats/ams2/dump";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { profiles, sessions } from "@raceiq/backend-core/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { assertSafeTarget, seedRowCount } from "@raceiq/tooling-data/data/seed-db-safety";
import { seedIRacingSession } from "@raceiq/tooling-data/data/seed-db-iracing";
import { insertDemoRows, markOnboardingComplete } from "@raceiq/tooling-data/data/seed-db-demo";
import { removeSeedData } from "@raceiq/tooling-data/data/seed-db-reset";
import { FIXTURES, PROFILE_NAME, parseOptions, SEED_MARKER } from "@raceiq/tooling-data/data/seed-db-options";
import { combineRecordingParts } from "@raceiq/backend-core/session-capture/combine-recording-parts";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
import { notifyDriverProfileLap } from "../../src/driver-profile/runner";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { reconcileLmuOpponentIndexes, stopLmuOpponentIndexRuntime } from "@raceiq/backend-core/session-capture/lmu-opponent-index-runtime";

async function placeSeedRecordingsInLegacyLayout(): Promise<void> {
  const root = resolveRecordingDirectory();
  const rows = await db.select({ gameId: sessions.gameId, rawFile: sessions.rawFile })
    .from(sessions).where(like(sessions.notes, `%${SEED_MARKER}%`)).all();
  const moved = new Set<string>();
  for (const row of rows) {
    if (!row.rawFile || moved.has(row.rawFile)) continue;
    const source = resolve(row.rawFile);
    const parts = relative(root, source).split(sep);
    if (parts.length === 2 && parts[0] === row.gameId) continue;
    if (parts.length !== 3 || parts[0] !== row.gameId || !["own", "others"].includes(parts[1]!)) {
      throw new Error(`Seed recording is outside the organized recording layout: ${source}`);
    }
    const destination = join(root, row.gameId, basename(source));
    await mkdir(join(root, row.gameId), { recursive: true });
    // Exclusive publication: never replace a recording already in the old layout.
    await link(source, destination);
    try {
      await db.update(sessions).set({ rawFile: destination })
        .where(and(eq(sessions.rawFile, row.rawFile), like(sessions.notes, `%${SEED_MARKER}%`))).run();
    } catch (error) {
      await unlink(destination);
      throw error;
    }
    await unlink(source);
    moved.add(row.rawFile);
  }
  console.log(`[DB Seed] Legacy recording layout ready: ${moved.size} files moved. Open RaceIQ to organize recordings.`);
}
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

async function importLMUSeedCapture(path: string, legacyRecordings: boolean) {
  const frames = streamLMUSeedFrames(path);
  try {
    const first = await frames.next();
    if (first.done) throw new Error(`No LMU source frames in ${path}`);
    const native = decodeLMUSourceFrame(first.value);
    if (!native) throw new Error(`Invalid LMU source frame in ${path}`);
    const partitioned = !legacyRecordings && (native.schemaVersion === 2 || native.schemaVersion === 3);
    async function* source() {
      yield first.value;
      yield* frames;
    }
    return await importSessionFrames(source(), "lmu", {
      notifyDriverProfile: false,
      opponentRetention: partitioned ? "retained" : undefined,
      recorder: partitioned ? undefined : new SparseSessionRecorderAdapter("mine", {}, "offline"),
    });
  } finally {
    await frames.return(undefined);
  }
}

function* seedCaptureFrames(path: string) {
  const bytes = decompressIfGzipSync(readFileSync(path));
  for (const record of iterateSessionCaptureRecords(bytes)) {
    if (record.kind === "frame") {
      yield record.frameTimeMs === undefined
        ? record.frame
        : { frame: record.frame, frameTimeMs: record.frameTimeMs };
    } else if (record.kind === "segment-boundary") {
      yield SESSION_SEGMENT_BOUNDARY;
    } else if (record.kind === "segment-context") {
      yield SESSION_SEGMENT_CONTEXT;
    } else {
      yield SESSION_SEGMENT_CONTEXT_END;
    }
  }
}
async function reconcileSeedLmuOpponentIndexes(): Promise<number> {
  const indexStartedAt = performance.now();
  const result = await reconcileLmuOpponentIndexes({ awaitPreparation: true });
  if (result === "pending") {
    console.log("[DB Seed] Opponent index pending; publication deferred for recording activity.");
  }
  return performance.now() - indexStartedAt;
}


async function main(): Promise<void> {
  const seedStartedAt = performance.now();
  let importDurationMs = 0;
  const options = parseOptions();
  await initDb();
  initGameAdapters(developmentReleaseFeatures);
  initServerGameAdapters(developmentReleaseFeatures);
  registerDriverProfileLapNotifier(notifyDriverProfileLap);
  await assertSafeTarget(options.force);
  if (options.reset) await removeSeedData();
  if (await seedRowCount()) {
    if (options.legacyRecordings) await placeSeedRecordingsInLegacyLayout();
    markOnboardingComplete();
    const indexDurationMs = await reconcileSeedLmuOpponentIndexes();
    const seedDurationMs = performance.now() - seedStartedAt;
    console.log(`[DB Seed] Durations: seed=${seedDurationMs.toFixed(1)}ms, import=0.0ms, index=${indexDurationMs.toFixed(1)}ms.`);
    console.log("[DB Seed] Seed data already exists; nothing to do.");
    return;
  }

  const profile = await db.insert(profiles).values({ name: PROFILE_NAME }).returning({ id: profiles.id }).get();
  const importedLapIds: number[] = [];
  const excludedFixtures = new Set(options.excludedFixtures);
  for (const game of options.games) {
    const fixtures = (options.fixtures ?? FIXTURES[game]).filter((fixture) => !excludedFixtures.has(fixture));
    if (fixtures.length === 0) {
      console.log(`[DB Seed] ${game}: skipped; no recording fixtures are configured.`);
      continue;
    }
    for (const fixture of fixtures) {
      const partMatch = /^(.*)\.part(\d+)$/i.exec(fixture);
      if (partMatch && Number(partMatch[2]) !== 1) continue;
      const partPaths = (partMatch
        ? fixtures.filter((path) => {
            const match = /^(.*)\.part\d+$/i.exec(path);
            return match?.[1]?.toLowerCase() === partMatch[1]!.toLowerCase();
          })
        : [fixture]
      ).map((path) => resolve(ROOT_DIR, path));
      for (const partPath of partPaths) {
        if (!existsSync(partPath)) throw new Error(`Missing seed fixture: ${partPath}`);
      }
      const combined = partMatch ? await combineRecordingParts(partPaths) : null;
      const fixturePath = combined?.path ?? partPaths[0]!;
      try {
        if (game === "iracing") {
          if (!fixturePath.toLowerCase().endsWith(".ibt")) {
            await seedIRacingSession(fixturePath);
            continue;
          }
          const existingSessionIds = new Set(
            (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all()).map((row) => row.id),
          );
          const staged = await stageIbtUpload(
            Bun.file(fixturePath).stream(),
            basename(fixturePath),
          );
          if (!staged.token) throw new Error(`iRacing seed fixture cannot be imported: ${staged.preview.reason ?? fixturePath}`);
          const result = await commitStagedIbt(staged.token, "mine", { notifyDriverProfile: false });
          const createdSessionIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all())
            .map((row) => row.id)
            .filter((id) => !existingSessionIds.has(id));
          if (createdSessionIds.length === 0) throw new Error(`No iRacing telemetry imported from ${fixturePath}`);
          await db.update(sessions).set({ notes: SEED_MARKER }).where(inArray(sessions.id, createdSessionIds)).run();
          importedLapIds.push(...result.laps.filter((lap) => lap.isValid).map((lap) => lap.lapId));
          console.log(`[DB Seed] iracing: ${result.laps.length} laps from ${fixture}`);
          const importStartedAt = performance.now();
          try {
            await seedIRacingSession(fixturePath);
          } finally {
            importDurationMs += performance.now() - importStartedAt;
          }
          continue;
        }
        const existingSessionIds = new Set(
          (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all()).map((row) => row.id),
        );
        console.log(`[DB Seed] ${game}: ${game === "lmu" ? "streaming" : "converting"} ${fixture} to sparse storage...`);
        const importStartedAt = performance.now();
        const converted = game === "lmu" ? null : await convertSeedFramesToSparse(
          game,
          game === "ams2" ? readAMS2DumpFrames(fixturePath) : seedCaptureFrames(fixturePath),
        );
        try {
          const importOptions = {
            notifyDriverProfile: false,
            recorder: new SparseSessionRecorderAdapter("mine", {}, "offline"),
          };
          const result = converted
            ? await importSessionBin(readFileSync(converted.path), game, importOptions)
            : await importLMUSeedCapture(fixturePath, options.legacyRecordings);
          importDurationMs += performance.now() - importStartedAt;
          const seededSessionIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.gameId, game)).all())
            .map((row) => row.id)
            .filter((id) => !existingSessionIds.has(id));
          if (seededSessionIds.length === 0) {
            throw new Error(`No ${game} telemetry imported from ${fixturePath}`);
          }
          await db.update(sessions).set({ notes: SEED_MARKER }).where(inArray(sessions.id, seededSessionIds)).run();
          importedLapIds.push(...result.laps.filter((lap) => lap.isValid).map((lap) => lap.lapId));
          console.log(`[DB Seed] ${game}: ${result.packetCount} packets, ${result.laps.length} laps from ${fixture}`);
        } finally {
          converted?.cleanup();
        }
      } finally {
        combined?.cleanup();
      }
    }
  }
  if (importedLapIds.length) {
    console.log(`[DB Seed] Adding demo rows for ${importedLapIds.length} imported laps.`);
    await insertDemoRows(profile.id, importedLapIds);
    console.log("[DB Seed] Demo rows ready.");
  }
  if (options.legacyRecordings) await placeSeedRecordingsInLegacyLayout();
  markOnboardingComplete();
  const indexDurationMs = await reconcileSeedLmuOpponentIndexes();
  const seedDurationMs = performance.now() - seedStartedAt;
  console.log(`[DB Seed] Durations: seed=${seedDurationMs.toFixed(1)}ms, import=${importDurationMs.toFixed(1)}ms, index=${indexDurationMs.toFixed(1)}ms.`);
  console.log(`[DB Seed] Seed complete: ${importedLapIds.length} valid laps, ${options.games.join(", ")}.`);
}

try {
  await main();
} finally {
  stopMaintenanceTasks();
  await stopLmuOpponentIndexRuntime();
  closeDb();
}
