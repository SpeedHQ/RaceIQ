/**
 * Rebuild the compact real-telemetry iRacing seed fixture from an IBT capture.
 *
 * Usage:
 *   bun scripts/generate-iracing-seed-fixture.ts <recording.ibt>
 *
 * The selected window starts at lap 413, retains the lap 414 pit entry and lap
 * 415 service/exit, and ends after lap 417's native timer rollover. Ten samples
 * per second preserve telemetry shape while keeping the committed fixture small.
 * Source frames use schema v2 intentionally: IBT SessionInfo contains driver
 * identities, which do not belong in a committed test artifact.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, resolve } from "path";
import { gzipSync } from "zlib";
import { IRacingIbtReader } from "../server/games/iracing/ibt-reader";
import { IRacingRecorder } from "../server/games/iracing/recorder";
import { parseIRacingSessionInfo } from "../server/games/iracing/session-info";
import {
  IRacingSourceFrameEncoder,
  type IRacingSessionSnapshot,
} from "../server/games/iracing/source-frame";

const FIRST_LAP = 413;
const PIT_LAP = 415;
const LAST_LAP = 417;
const TARGET_TICK_RATE = 10;
const TIMING_ROLLOVER_SECONDS = 5;
const ANONYMOUS_SESSION_ID = 123;
const ANONYMOUS_SUBSESSION_ID = 456;
const OUTPUT = resolve(
  import.meta.dir,
  "..",
  "test",
  "artifacts",
  "sessions",
  "iracing-daytona-am-vantage-gt3-pit.bin.gz",
);

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: bun scripts/generate-iracing-seed-fixture.ts <recording.ibt>");
}
const sourcePath = resolve(input);
if (!existsSync(sourcePath)) {
  throw new Error(`IBT source does not exist: ${sourcePath}`);
}

async function generateFixture(sourcePath: string): Promise<void> {
  const tempDir = mkdtempSync(resolve(tmpdir(), "raceiq-iracing-seed-fixture-"));
  const reader = new IRacingIbtReader(sourcePath);
  const recorder = new IRacingRecorder();
  const encoder = new IRacingSourceFrameEncoder();
  const sessions = new Map<number, IRacingSessionSnapshot>();
  let selectedStartRecord: number | null = null;
  let selectedEndRecord: number | null = null;
  let firstRolloverTime: number | null = null;
  let previousLap: number | null = null;
  let previousPit: boolean | null = null;
  let pitFrames = 0;
  let sawPitExit = false;

  try {
    const rawPath = recorder.start(tempDir);
    try {
      reader.start();
      const tickRate = reader.metadata?.tickRate;
      if (!tickRate || !Number.isFinite(tickRate)) {
        throw new Error("IBT source has no valid tick rate");
      }
      const frameStride = Math.max(
        1,
        Math.round(tickRate / TARGET_TICK_RATE),
      );

      for (;;) {
        const snapshot = reader.readLatest();
        if (!snapshot) break;
        const record = reader.recordsRead - 1;
        const lap = Number(snapshot.values.Lap);
        const onPitRoad =
          snapshot.values.OnPitRoad === true ||
          snapshot.values.OnPitRoad === 1;
        const sessionTime = Number(snapshot.values.SessionTime);

        if (selectedStartRecord === null) {
          if (lap !== FIRST_LAP) {
            previousLap = lap;
            previousPit = onPitRoad;
            continue;
          }
          selectedStartRecord = record;
        }

        if (lap === LAST_LAP + 1 && firstRolloverTime === null) {
          firstRolloverTime = sessionTime;
        }
        if (
          lap > LAST_LAP + 1 ||
          (firstRolloverTime !== null &&
            sessionTime - firstRolloverTime > TIMING_ROLLOVER_SECONDS)
        ) {
          break;
        }

        const sessionNum = Math.trunc(Number(snapshot.values.SessionNum));
        let session = sessions.get(sessionNum);
        if (!session) {
          session = {
            ...parseIRacingSessionInfo(snapshot.sessionInfo, sessionNum),
            sessionId: ANONYMOUS_SESSION_ID,
            subSessionId: ANONYMOUS_SUBSESSION_ID,
          };
          sessions.set(sessionNum, session);
        }

        if (lap === PIT_LAP && onPitRoad) pitFrames++;
        if (previousPit === true && !onPitRoad) sawPitExit = true;
        const keepFrame =
          recorder.frameCount === 0 ||
          (record - selectedStartRecord) % frameStride === 0 ||
          lap !== previousLap ||
          onPitRoad !== previousPit;
        if (keepFrame) {
          recorder.writeFrame(
            encoder.encode({
              schemaVersion: 2,
              session,
              values: snapshot.values,
            }),
          );
          selectedEndRecord = record;
        }
        previousLap = lap;
        previousPit = onPitRoad;
      }

      if (selectedStartRecord === null || selectedEndRecord === null) {
        throw new Error(`IBT source does not contain lap ${FIRST_LAP}`);
      }
      if (pitFrames === 0 || !sawPitExit) {
        throw new Error(
          `IBT source does not contain lap ${PIT_LAP}'s complete pit-road segment`,
        );
      }
      if (firstRolloverTime === null) {
        throw new Error(
          `IBT source ends before lap ${LAST_LAP}'s timing rollover`,
        );
      }
    } finally {
      await reader.stop();
      await recorder.stop();
    }

    const raw = readFileSync(rawPath);
    writeFileSync(OUTPUT, gzipSync(raw, { level: 9 }));
    console.log(
      `Wrote ${recorder.frameCount} frames from records ${selectedStartRecord}-${selectedEndRecord} ` +
        `to ${OUTPUT} (${(statSync(OUTPUT).size / 1024 / 1024).toFixed(2)} MiB)`,
    );
    console.log(`Source: ${basename(sourcePath)}; pit lap: ${PIT_LAP}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await generateFixture(sourcePath);
