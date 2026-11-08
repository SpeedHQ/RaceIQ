import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameId } from "@raceiq/shared/games/ids";
import {
  encodeSegmentBoundaryFrame,
  encodeSegmentContextEndFrame,
  encodeSegmentContextFrame,
  SESSION_SEGMENT_BOUNDARY,
  SESSION_SEGMENT_CONTEXT,
  SESSION_SEGMENT_CONTEXT_END,
} from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";

export type SeedCaptureFrame =
  | Buffer
  | { frame: Buffer; frameTimeMs?: number }
  | typeof SESSION_SEGMENT_BOUNDARY
  | typeof SESSION_SEGMENT_CONTEXT
  | typeof SESSION_SEGMENT_CONTEXT_END;

type SeedCaptureSource = Iterable<SeedCaptureFrame> | AsyncIterable<SeedCaptureFrame>;

export async function convertSeedFramesToSparse(
  gameId: GameId,
  frames: SeedCaptureSource,
): Promise<{ path: string; cleanup(): void }> {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-seed-sparse-"));
  const path = join(directory, "capture.bin");
  const recorder = new SparseSessionRecorder(gameId);
  let frameCount = 0;
  try {
    recorder.start(path);
    recorder.writeMetaFrame();
    for await (const item of frames) {
      if (item === SESSION_SEGMENT_BOUNDARY) {
        recorder.writeRawCaptureBytes(encodeSegmentBoundaryFrame());
      } else if (item === SESSION_SEGMENT_CONTEXT) {
        recorder.writeRawCaptureBytes(encodeSegmentContextFrame());
      } else if (item === SESSION_SEGMENT_CONTEXT_END) {
        recorder.writeRawCaptureBytes(encodeSegmentContextEndFrame());
      } else if (Buffer.isBuffer(item)) {
        recorder.writeRecord(item);
        frameCount++;
      } else {
        recorder.writeRecord(item.frame, item.frameTimeMs);
        frameCount++;
      }
    }
    if (frameCount === 0) throw new Error(`No source frames available to convert for ${gameId}`);
    await recorder.stop();
    return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    try {
      await recorder.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
