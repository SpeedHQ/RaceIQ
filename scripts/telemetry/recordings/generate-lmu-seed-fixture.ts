/**
 * Rebuild compact real-telemetry LMU fixture from LMU DuckDB recording.
 *
 * Usage:
 *   bun scripts/telemetry/recordings/generate-lmu-seed-fixture.ts <recording.duckdb>
 *
 * Selected window retains complete race laps 6 and 7 plus enough adjacent
 * telemetry to establish session state and close final lap. Ten samples per
 * second preserve telemetry shape while keeping committed fixture small.
 * Driver identity is replaced before fixture is written.
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
import {
  previewLMUDuckDB,
  readLMUDuckDBFrames,
} from "../../../server/games/lmu/import-duckdb";
import { lmuServerAdapter } from "../../../server/games/lmu";
import {
  LMU_SCORING_INFO,
  LMU_SCORING_VEHICLE,
} from "../../../server/games/lmu/layout";
import { LMURecorder } from "../../../server/games/lmu/recorder";
import { decodeLMUSourceFrame } from "../../../server/games/lmu/source-frame";

const FIRST_LAP = 5;
const LAST_LAP = 7;
const TARGET_FRAME_RATE = 10;
const SOURCE_FRAME_RATE = 50;
const FINAL_LAP_ROLLOVER_SECONDS = 5;
const ANONYMOUS_DRIVER = "RaceIQ Fixture";
const OUTPUT = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test",
  "artifacts",
  "sessions",
  "lmu-spa-iron-lynx-gte.bin.gz",
);

const input = process.argv[2];
if (!input) {
  throw new Error(
    "Usage: bun scripts/telemetry/recordings/generate-lmu-seed-fixture.ts <recording.duckdb>",
  );
}
const sourcePath = resolve(input);
if (!existsSync(sourcePath)) {
  throw new Error(`LMU DuckDB source does not exist: ${sourcePath}`);
}

function writeCString(
  buffer: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  buffer.fill(0, offset, offset + length);
  Buffer.from(value, "utf8").copy(buffer, offset, 0, length - 1);
}

function anonymizeFrame(source: Buffer): Buffer {
  const frameBytes = Buffer.from(source);
  const frame = decodeLMUSourceFrame(frameBytes);
  if (!frame) throw new Error("LMU DuckDB produced invalid source frame");
  writeCString(
    frame.scoringInfo,
    LMU_SCORING_INFO.playerName,
    32,
    ANONYMOUS_DRIVER,
  );
  if (frame.playerScoring) {
    writeCString(
      frame.playerScoring,
      LMU_SCORING_VEHICLE.driverName,
      32,
      ANONYMOUS_DRIVER,
    );
  }
  return frameBytes;
}

async function generateFixture(): Promise<void> {
  const preview = await previewLMUDuckDB(sourcePath);
  const temporaryDirectory = mkdtempSync(
    resolve(tmpdir(), "raceiq-lmu-seed-fixture-"),
  );
  const recorder = new LMURecorder();
  const seenLaps = new Set<number>();
  const stride = Math.max(1, Math.round(SOURCE_FRAME_RATE / TARGET_FRAME_RATE));
  let sourceFrameIndex = 0;
  let selectedStartFrame: number | null = null;
  let selectedEndFrame: number | null = null;
  let previousLap: number | null = null;

  try {
    const rawPath = recorder.start(temporaryDirectory);
    for await (const sourceFrame of readLMUDuckDBFrames(sourcePath)) {
      const packet = lmuServerAdapter.tryParse(sourceFrame, null);
      const frameIndex = sourceFrameIndex++;
      const lap = packet?.LapNumber;
      if (!packet || lap === undefined) continue;

      if (selectedStartFrame === null) {
        if (lap !== FIRST_LAP) {
          previousLap = lap;
          continue;
        }
        selectedStartFrame = frameIndex;
      }

      if (
        lap > LAST_LAP &&
        packet.CurrentLap > FINAL_LAP_ROLLOVER_SECONDS
      ) {
        break;
      }

      seenLaps.add(lap);
      const lapChanged = lap !== previousLap;
      const keepFrame =
        recorder.frameCount === 0 ||
        (frameIndex - selectedStartFrame) % stride === 0 ||
        lapChanged;
      if (keepFrame) {
        recorder.writeFrame(anonymizeFrame(sourceFrame));
        selectedEndFrame = frameIndex;
      }
      previousLap = lap;
    }
    await recorder.stop();

    for (let lap = FIRST_LAP; lap <= LAST_LAP; lap++) {
      if (!seenLaps.has(lap)) {
        throw new Error(`LMU source does not contain selected lap ${lap}`);
      }
    }
    if (selectedStartFrame === null || selectedEndFrame === null) {
      throw new Error("LMU source produced no fixture frames");
    }

    const raw = readFileSync(rawPath);
    const sourceDriver = Buffer.from(preview.driverName, "utf8");
    if (sourceDriver.length > 0 && raw.includes(sourceDriver)) {
      throw new Error("LMU fixture still contains source driver identity");
    }
    writeFileSync(OUTPUT, gzipSync(raw, { level: 9 }));
    console.log(
      `Wrote ${recorder.frameCount} frames from source frames ${selectedStartFrame}-${selectedEndFrame} ` +
        `to ${OUTPUT} (${(statSync(OUTPUT).size / 1024 / 1024).toFixed(2)} MiB)`,
    );
    console.log(
      `Source: ${basename(sourcePath)}; laps: ${FIRST_LAP}-${LAST_LAP}; driver: ${ANONYMOUS_DRIVER}`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

await generateFixture();
