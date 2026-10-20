import { rm, stat } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import type { Manifest } from "@raceiq/capture-splitting";
import { prepareCaptureBundle } from "@raceiq/capture-splitting/prepare-bundle";
import { captureSourceFiles } from "@raceiq/capture-splitting/source-files";
import { PARSER_BOOTSTRAP_VERSION } from "@raceiq/capture-formats/session/framing";
import { db } from "../db/index";
import { laps, sessions } from "../db/schema";
import { getSessionCaptureSourceRevision } from "../db/session-queries";
import { getServerGame } from "../games/registry";
import { iterateSessionCaptureRecordsFromSource, loadCaptureManifest, type SessionCaptureSource } from "./source-loader";

export type DownsampleCaptureBundle = {
  sessionId: number;
  expectedManifestFile: string | null;
  expectedArchiveFile: string | null;
  expectedLayoutVersion: number | null;
  expectedLaps: Array<{ id: number; captureChunkId: string | null; sourceFrameStart: number | null; sourceFrameCount: number | null }>;
  manifestPath: string;
  manifest: Manifest;
};

/** Include all authoritative replay files, not just a manifest's JSON bytes. */
export async function downsampleSourceFiles(rawFile: string, sessionIds: readonly number[]): Promise<Map<string, number>> {
  const rows = await db.select({ manifestFile: sessions.captureManifestFile, archiveFile: sessions.captureArchiveFile })
    .from(sessions).where(inArray(sessions.id, [...sessionIds])).all();
  const manifests = new Set(rows.flatMap((row) => row.manifestFile ? [row.manifestFile] : []));
  if (rawFile.endsWith("manifest.json")) manifests.add(rawFile);
  const loaded = [];
  for (const path of manifests) loaded.push({ path, manifest: await loadCaptureManifest(path) });
  return captureSourceFiles({
    rawFile,
    archiveFiles: rows.flatMap((row) => row.archiveFile ? [row.archiveFile] : []),
    manifests: loaded,
  });
}

/** Build immutable replacement artifacts before the transaction switches replay authority. */
export async function prepareDownsampleCaptureBundles(
  source: SessionCaptureSource,
  sessionIds: readonly number[],
  indexes: readonly { lapId: number; rawByteOffset: number; rawFrameCount: number }[],
): Promise<DownsampleCaptureBundle[]> {
  const rows = await db.select().from(sessions).where(inArray(sessions.id, [...sessionIds])).all();
  const bundles: DownsampleCaptureBundle[] = [];
  const created: string[] = [];
  const rewritten = new Map(indexes.map((index) => [index.lapId, index]));
  try {
    for (const row of rows) {
      const lapRows = await db.select().from(laps).where(eq(laps.sessionId, row.id)).all();
      if (row.captureLayoutVersion === null && !row.captureManifestFile && !row.captureArchiveFile && !lapRows.some((lap) => lap.captureChunkId !== null)) continue;
      const windows = lapRows.map((lap) => {
        const index = rewritten.get(lap.id);
        if (!index) throw new Error(`Cannot publish downsampled bundle without lap ${lap.id} index`);
        return { lapId: String(lap.id), lapNumber: lap.lapNumber, startByteOffset: index.rawByteOffset, frameCount: index.rawFrameCount };
      }).sort((a, b) => a.startByteOffset - b.startByteOffset);
      const game = getServerGame(source.gameId);
      const directory = `${source.rawFile}.session-${row.id}.bundle`;
      const bundle = await prepareCaptureBundle({
        sourcePath: source.rawFile,
        outputDirectory: directory,
        sourceRevision: getSessionCaptureSourceRevision(await stat(source.rawFile), windows, source.gameId),
        windows,
        source: () => iterateSessionCaptureRecordsFromSource(source, { strict: true }),
        codec: {
          gameId: game.id,
          appendsDelayedFinishFrame: game.appendsDelayedFinishFrame,
          createState: () => game.createParserState(),
          ...(game.captureParserCheckpoint ? { captureCheckpoint: (state: unknown) => game.captureParserCheckpoint!(state) } : {}),
          ...(game.restoreParserCheckpoint ? { restoreCheckpoint: (state: unknown, payload: Uint8Array) => game.restoreParserCheckpoint!(state, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)) } : {}),
          parseFrame: (frame: Uint8Array, state: unknown) => game.tryParse(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), state),
          primeFrame: (frame: Uint8Array, state: unknown) => game.primeParserState(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), state),
        },
        bootstrapVersion: PARSER_BOOTSTRAP_VERSION,
      });
      created.push(directory);
      bundles.push({
        sessionId: row.id, expectedManifestFile: row.captureManifestFile,
        expectedArchiveFile: row.captureArchiveFile, expectedLayoutVersion: row.captureLayoutVersion,
        expectedLaps: lapRows.map(({ id, captureChunkId, sourceFrameStart, sourceFrameCount }) => ({ id, captureChunkId, sourceFrameStart, sourceFrameCount })),
        ...bundle,
      });
    }
    return bundles;
  } catch (error) {
    for (const directory of created) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
