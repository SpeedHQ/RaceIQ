import { KNOWN_GAME_IDS, type GameId } from "@raceiq/shared/games/ids";
import { getAllServerGames } from "../games/registry";
import { hasLMUDumpMagic, readLMUFramesFromBuffer } from "@raceiq/capture-formats/lmu/dump";
import { IRACING_DUMP_MAGIC, readIRacingFramesFromBuffer } from "@raceiq/capture-formats/iracing/dump";
import {
  decompressIfGzipSync,
  iterateSessionFrames,
  iterateSessionCaptureRecords,
  SESSION_SEGMENT_BOUNDARY,
  SESSION_SEGMENT_CONTEXT,
  SESSION_SEGMENT_CONTEXT_END,
} from "./framing";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveDataDir } from "../runtime/config/data-dir";
import { getRecordingEngineKind } from "../runtime/recorder-engine";
import { importStagedWithRust } from "./import-results";
import { importSessionFrames, type ImportedLap, type ImportSessionOptions } from "./import-pipeline";

const GAME_IDS_BY_FILENAME_PRECEDENCE = [...KNOWN_GAME_IDS].sort(
  (a, b) => b.length - a.length,
);

/** Detect a gameId from an uploaded filename prefix (`<gameId>-...` / `<gameId>_...`). */
export function detectGameIdFromFilename(name: string): GameId | null {
  for (const id of GAME_IDS_BY_FILENAME_PRECEDENCE) {
    if (name.startsWith(`${id}-`) || name.startsWith(`${id}_`)) return id;
  }
  return null;
}

/** Detect a gameId from actual capture frame content. */
export function detectGameIdFromBuffer(bytes: Buffer): GameId | null {
  if (getRecordingEngineKind() === "rust") throw new Error("Game detection from decoded Bun frames is disabled while Rust recorder is selected");
  const buf = decompressIfGzipSync(bytes);
  const games = getAllServerGames();
  let checked = 0;
  const frames = hasLMUDumpMagic(buf) ? readLMUFramesFromBuffer(buf)
    : buf.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)
      ? readIRacingFramesFromBuffer(buf, 20) : iterateSessionFrames(buf);
  for (const frame of frames) {
    for (const game of games) {
      if (game.canHandle(frame)) return game.id;
    }
    checked++;
    if (checked >= 20) break;
  }
  return null;
}
function* canonicalImportFrames(bytes: Buffer) {
  for (const record of iterateSessionCaptureRecords(bytes)) {
    if (record.kind === "frame") yield { frame: record.frame, frameTimeMs: record.frameTimeMs };
    else if (record.kind === "segment-boundary") yield SESSION_SEGMENT_BOUNDARY;
    else if (record.kind === "segment-context") yield SESSION_SEGMENT_CONTEXT;
    else yield SESSION_SEGMENT_CONTEXT_END;
  }
}


/** Replay a canonical session capture through parser, detector, and persistence pipeline. */
export async function importSessionBin(
  bytes: Buffer,
  gameId: GameId,
  options: ImportSessionOptions = {},
): Promise<{ packetCount: number; laps: ImportedLap[] }> {
  if (getRecordingEngineKind() === "rust") {
    const stagingRoot = resolve(resolveDataDir(), "recorder-jobs");
    await mkdir(stagingRoot, { recursive: true });
    const jobRoot = await mkdtemp(join(stagingRoot, "legacy-import-"));
    const inputPath = join(jobRoot, `${randomUUID()}.bin`);
    const outputRoot = join(jobRoot, "output");
    await mkdir(outputRoot);
    await writeFile(inputPath, bytes);
    try {
      const result = await importStagedWithRust({
        path: inputPath,
        originalName: `${gameId}.bin`,
        outputRoot,
        jobId: randomUUID(),
        gameId,
        ownership: options.ownership,
        sessionSource: options.sessionSource,
        requireLaps: options.requireLaps,
        notifyDriverProfile: options.notifyDriverProfile,
        captureStorage: options.recorder ? "raw" : "sparse",
        onImportedLaps: options.onImportedLaps,
      });
      return { packetCount: result.packetCount, laps: result.laps };
    } finally {
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const buf = decompressIfGzipSync(bytes);
  const frames = gameId === "lmu" && hasLMUDumpMagic(buf)
    ? readLMUFramesFromBuffer(buf)
    : gameId === "iracing" && buf.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)
      ? readIRacingFramesFromBuffer(buf) : canonicalImportFrames(buf);
  const { packetCount, laps } = await importSessionFrames(
    frames,
    gameId,
    options,
  );
  return { packetCount, laps };
}
