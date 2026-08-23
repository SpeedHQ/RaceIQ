import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initGameAdapters } from "../../shared/games/init";
import { deleteSession, insertSession, updateSessionRawFile } from "../../server/db/session-queries";
import { initServerGameAdapters } from "../../server/games/init";
import { resolveDataDir } from "../../server/runtime/config/data-dir";
import { SessionRecorder } from "../../server/session-capture/recorder";
import { getRecordingFixture } from "../support/recordings/fixtures";
import { readUdpDump } from "../support/recordings/udp";
import { assertCanonicalArchiveGameContract } from "../support/session-capture/canonical-archive-game-contract";

initGameAdapters();
initServerGameAdapters();

const F1_RECORDING = "f1-2025-2026-04-09T21-34-10-190Z.bin.gz";
// Frame 397 is first fixture prefix containing motion, session, lap-data, and
// car-telemetry packets required by F1StateAccumulator to emit telemetry.
// Preserve post-bootstrap observations without turning contract coverage into
// a max-duration archive stress test.
const F1_ARCHIVE_FRAME_LIMIT = 512;

describe("F1 2025 canonical archive contract", () => {
  test("builds verified canonical evidence from recorder-framed F1 telemetry", async () => {
    const recording = getRecordingFixture(F1_RECORDING);
    if (!recording) throw new Error(`Required recording not found: ${F1_RECORDING}`);

    const directory = mkdtempSync(join(tmpdir(), "raceiq-canonical-f1-2025-"));
    const rawFile = join(directory, "f1-2025-session.bin");
    let sessionId: number | undefined;

    try {
      const recorder = new SessionRecorder();
      recorder.start(rawFile);
      recorder.writeMetaFrame();
      const frames = readUdpDump(recording, F1_ARCHIVE_FRAME_LIMIT);
      expect(frames).toHaveLength(F1_ARCHIVE_FRAME_LIMIT);
      for (const frame of frames) recorder.writeRecord(frame);
      expect((await recorder.stop()).state).toBe("verified");

      sessionId = await insertSession(1, 1, "f1-2025", "race");
      await updateSessionRawFile(sessionId, rawFile, "canonical-archive-f1-2025-test");

      await assertCanonicalArchiveGameContract({
        sessionId,
        gameId: "f1-2025",
        rawFile,
      });
    } finally {
      if (sessionId !== undefined) {
        await deleteSession(sessionId);
        rmSync(join(resolveDataDir(), "archives", "sessions", String(sessionId)), {
          recursive: true,
          force: true,
        });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
