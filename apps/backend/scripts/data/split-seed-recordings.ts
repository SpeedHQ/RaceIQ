import { eq, ne } from "drizzle-orm";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { initDb, closeDb, readDb } from "@raceiq/backend-core/db/index";
import { laps, sessionCaptureSplitJobs, sessions } from "@raceiq/backend-core/db/schema";
import { deleteEmptySessions, recoverSessionCaptureSplitJobs } from "@raceiq/backend-core/db/session-queries";
import {
  iterateSessionCaptureRecordsFromSource,
  loadCaptureManifest,
  type SessionCaptureSource,
} from "@raceiq/backend-core/session-capture/source-loader";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { DEFAULT_GAMES } from "@raceiq/tooling-data/data/seed-db-options";
import { developmentReleaseFeatures } from "@raceiq/tooling-release/release/development-release-features";
import { initServerGameAdapters } from "../../src/games/init";
import { runSessionCaptureSplitQueueOnce } from "../../src/session-capture/split-manager";

async function verifySplitFixtures(): Promise<void> {
  const fixtures = await readDb.select().from(sessions).all();
  for (const game of DEFAULT_GAMES) {
    if (!fixtures.some(({ gameId }) => gameId === game)) throw new Error(`No seed sessions for ${game}`);
  }
  for (const fixture of fixtures) {
    const { id, gameId, captureFormatVersion, captureLayoutVersion, captureManifestFile } = fixture;
    const label = `game=${gameId} session=${id}`;
    if (captureFormatVersion !== 1 || captureLayoutVersion !== 1 || !captureManifestFile) {
      throw new Error(`${label} has no published per-lap capture`);
    }
    const manifest = await loadCaptureManifest(captureManifestFile);
    if (manifest.version !== 3 || manifest.gameId !== gameId) throw new Error(`${label} has an invalid split manifest`);
    const lapRows = await readDb.select({
      id: laps.id, chunkId: laps.captureChunkId, frameCount: laps.sourceFrameCount,
    }).from(laps).where(eq(laps.sessionId, id)).all();
    const lapChunks = new Map(manifest.chunks.filter((chunk) => chunk.kind === "lap").map((chunk) => [chunk.id, chunk]));
    if (lapRows.length === 0 || lapRows.length !== lapChunks.size ||
        lapRows.some((lap) => {
          const chunk = lap.chunkId ? lapChunks.get(lap.chunkId) : undefined;
          return !chunk || chunk.lapId !== String(lap.id) || chunk.ownedFrameCount !== lap.frameCount;
        })) {
      throw new Error(`${label} has incomplete per-lap bindings`);
    }
    const directory = await realpath(dirname(captureManifestFile));
    const readFrames = async (name: string, byteLength: number, allowLegacyFullFrames = false) => {
      const path = await realpath(resolve(directory, name));
      const within = relative(directory, path);
      if (!within || isAbsolute(name) || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
        throw new Error(`${label} has a capture outside its manifest directory: ${name}`);
      }
      const info = await stat(path);
      if (!info.isFile() || info.size !== byteLength) throw new Error(`${label} has an invalid capture size: ${name}`);
      const source: SessionCaptureSource = {
        rawFile: path, source: fixture.source, gameId: manifest.gameId,
        carId: fixture.carId, trackId: fixture.trackId, captureFormatVersion,
      };
      let frames = 0;
      for await (const record of iterateSessionCaptureRecordsFromSource(source, { strict: true, allowLegacyFullFrames })) {
        if (record.kind === "frame") frames++;
      }
      return frames;
    };
    for (const chunk of manifest.chunks) {
      if (await readFrames(chunk.path, chunk.byteLength) < (chunk.ownedFrameCount ?? 0)) {
        throw new Error(`${label} has an incomplete capture chunk: ${chunk.path}`);
      }
    }
    if (manifest.opponentRetention === "retained" && manifest.opponentCompanion) {
      const { file, byteLength } = manifest.opponentCompanion;
      if (!await readFrames(file, byteLength, true)) throw new Error(`${label} has an empty opponent companion`);
    }
    console.log(`[Split Seed] ${label} verified ${lapRows.length} per-lap files`);
  }
}

try {
  await initDb();
  initGameAdapters(developmentReleaseFeatures);
  initServerGameAdapters(developmentReleaseFeatures);
  const emptySessions = await deleteEmptySessions();
  console.log(`[Split Seed] Removed ${emptySessions} empty sessions using release startup cleanup`);
  await recoverSessionCaptureSplitJobs();
  while (await runSessionCaptureSplitQueueOnce()) {}
  const unfinished = await readDb.select({
    sessionId: sessionCaptureSplitJobs.sessionId,
    status: sessionCaptureSplitJobs.status,
    error: sessionCaptureSplitJobs.errorMessage,
  }).from(sessionCaptureSplitJobs).where(ne(sessionCaptureSplitJobs.status, "ready")).all();
  if (unfinished.length) throw new Error(`Unfinished recording splits: ${JSON.stringify(unfinished)}`);
  await verifySplitFixtures();
} finally {
  closeDb();
}

