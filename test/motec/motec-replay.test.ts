import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRawLapFrames,
  parseSessionLapsBatchedForTest,
} from "../../server/db/telemetry-replay-storage";
import { initServerGameAdapters } from "../../server/games/init";
import { encodeMotecSourceArchive } from "../../server/motec/source-archive";
import type { SessionCaptureSource } from "../../server/session-capture/source-loader";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { buildLd, buildLdx, syntheticStint } from "../support/motec/ld";

initGameAdapters();
initServerGameAdapters();

const LAP_SECONDS = 40;
const RAW_FRAME_COUNT = LAP_SECONDS * 60;
let directory: string;
let source: SessionCaptureSource;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "raceiq-motec-replay-"));
  const rawFile = join(directory, "session.motec.zip");
  const { spec, beacons } = syntheticStint({
    laps: 3,
    lapSeconds: LAP_SECONDS,
    hz: 60,
  });
  await writeFile(
    rawFile,
    encodeMotecSourceArchive(buildLd(spec), Buffer.from(buildLdx(beacons))),
  );
  source = {
    rawFile,
    source: "motec",
    gameId: "ac-evo",
    carOrdinal: 1,
    trackOrdinal: -1,
  };
});

afterAll(async () => {
  stopMaintenanceTasks();
  await rm(directory, { recursive: true, force: true });
});
function expectDelayedFinish(packets: TelemetryPacket[]): void {
  expect(packets).toHaveLength(RAW_FRAME_COUNT + 1);
  expect(packets.at(-1)).toMatchObject({
    CurrentLap: LAP_SECONDS,
    LastLap: LAP_SECONDS,
    LapNumber: 1,
  });
}

describe("canonical MoTeC replay", () => {
  test("individual lap replay preserves the next-lap finish trigger", async () => {
    const packets = await parseRawLapFrames(source, 0, RAW_FRAME_COUNT);

    expectDelayedFinish(packets);
  });

  test("batched lap replay preserves the next-lap finish trigger", async () => {
    const batches = await parseSessionLapsBatchedForTest(source, [{
      id: 1,
      rawByteOffset: 0,
      rawFrameCount: RAW_FRAME_COUNT,
    }]);

    expectDelayedFinish(batches.get(1)!);
  });
});
