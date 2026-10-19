import { ROOT_DIR } from "../root";
/**
 * Rebuild compact, anonymized iRacing seed telemetry from an IBT capture.
 *
 * Usage:
 *   bun packages/tooling-data/src/iracing/generate-seed-fixture.ts <recording.ibt>
 *   bun packages/tooling-data/src/iracing/generate-seed-fixture.ts <recording.ibt> --full-recording --output <fixture.bin.gz>
 *
 * Default mode keeps the established Daytona pit-stop sample. Full-recording
 * mode samples the complete IBT at 4 Hz while retaining lap and pit transitions.
 * Schema v2 omits embedded SessionInfo driver identities from committed telemetry.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { IRacingIbtReader } from "@raceiq/game-iracing/ibt-reader";
import { IRacingRecorder } from "@raceiq/game-iracing/recorder";
import { parseIRacingSessionInfo } from "@raceiq/capture-formats/iracing/session-info";
import {
  IRacingSourceFrameEncoder,
  type IRacingSessionSnapshot,
} from "@raceiq/capture-formats/iracing/source-frame";

const FIRST_LAP = 413;
const PIT_LAP = 415;
const LAST_LAP = 417;
const TARGET_TICK_RATE = 10;
const FULL_RECORDING_TICK_RATE = 4;
const TIMING_ROLLOVER_SECONDS = 5;
const ANONYMOUS_SESSION_ID = 123;
const ANONYMOUS_SUBSESSION_ID = 456;
const OUTPUT = resolve(ROOT_DIR, "test/artifacts/sessions/iracing-daytona-am-vantage-gt3-pit.bin.gz");

const args = process.argv.slice(2);
const input = args.find((argument) => !argument.startsWith("--"));
const fullRecording = args.includes("--full-recording");
const outputIndex = args.indexOf("--output");
const outputArgument = outputIndex < 0 ? undefined : args[outputIndex + 1];
if (!input || (outputIndex >= 0 && !outputArgument) || (fullRecording && outputIndex < 0)) {
  throw new Error("Usage: bun packages/tooling-data/src/iracing/generate-seed-fixture.ts <recording.ibt> [--full-recording --output <fixture.bin.gz>]");
}
const sourcePath = resolve(input);
const outputPath = outputArgument ? resolve(ROOT_DIR, outputArgument) : OUTPUT;
if (!existsSync(sourcePath)) {
  throw new Error(`IBT source does not exist: ${sourcePath}`);
}

async function generateFixture(
  sourcePath: string,
  options: { fullRecording: boolean; outputPath: string },
): Promise<void> {
  const tempDir = mkdtempSync(resolve(tmpdir(), "raceiq-iracing-seed-fixture-"));
  const reader = new IRacingIbtReader(sourcePath);
  const recorder = new IRacingRecorder();
  const encoder = new IRacingSourceFrameEncoder();
  const sessions = new Map<number, IRacingSessionSnapshot>();
  let selectedStartRecord: number | null = options.fullRecording ? 0 : null;
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
      const targetTickRate = options.fullRecording
        ? FULL_RECORDING_TICK_RATE
        : TARGET_TICK_RATE;
      const frameStride = Math.max(
        1,
        Math.round(tickRate / targetTickRate),
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

        if (!options.fullRecording) {
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

        if (!options.fullRecording && lap === PIT_LAP && onPitRoad) pitFrames++;
        if (!options.fullRecording && previousPit === true && !onPitRoad) {
          sawPitExit = true;
        }
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
        throw new Error(
          options.fullRecording
            ? "IBT source contains no telemetry records"
            : `IBT source does not contain lap ${FIRST_LAP}`,
        );
      }
      if (!options.fullRecording && (pitFrames === 0 || !sawPitExit)) {
        throw new Error(
          `IBT source does not contain lap ${PIT_LAP}'s complete pit-road segment`,
        );
      }
      if (!options.fullRecording && firstRolloverTime === null) {
        throw new Error(
          `IBT source ends before lap ${LAST_LAP}'s timing rollover`,
        );
      }
    } finally {
      await reader.stop();
      await recorder.stop();
    }

    const raw = readFileSync(rawPath);
    writeFileSync(options.outputPath, gzipSync(raw, { level: 9 }));
    console.log(
      `Wrote ${recorder.frameCount} frames from records ${selectedStartRecord}-${selectedEndRecord} ` +
        `to ${options.outputPath} (${(statSync(options.outputPath).size / 1024 / 1024).toFixed(2)} MiB)`,
    );
    if (!options.fullRecording) {
      console.log(`Source: ${basename(sourcePath)}; pit lap: ${PIT_LAP}`);
    } else {
      console.log(`Source: ${basename(sourcePath)}; complete recording sampled at ${FULL_RECORDING_TICK_RATE} Hz`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await generateFixture(sourcePath, { fullRecording, outputPath });
