/**
 * ACC session lifecycle tests.
 *
 * Regression 1: launching ACC at the main menu bricked the shared-memory
 * reader. `StatusCheckProcessor` called `onDisconnect()` the moment it saw
 * `status == AC_OFF`, tearing the reader down with no path to reconnect.
 * Entering a race afterwards produced zero packets — UI stuck on "Waiting".
 *
 * Regression 2: sessions never ended when the user exited to the main menu
 * while the game process stayed alive. Mirror of the AC Evo fix.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { CapturingDbAdapter } from "../server/pipeline-adapters";
import { LapDetectorAcc } from "../server/lap-detector-acc";
import { StatusCheckProcessor } from "../server/games/acc/triplet-pipeline";
import { GRAPHICS, AC_STATUS } from "../server/games/acc/structs";
import { stopMaintenanceTasks } from "../server/pipeline";
import { readAccFrames } from "../server/games/acc/recorder";
import { parseAccBuffers } from "../server/games/acc/parser";

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

const ACC_FIXTURE = "test/artifacts/sessions/acc-2026-04-10T02-55-22-777Z.bin.gz";

function graphicsBufferWithStatus(status: number): Buffer {
  const g = Buffer.alloc(GRAPHICS.SIZE);
  g.writeInt32LE(status, GRAPHICS.status.offset);
  return g;
}

function emptyTriplet(status: number) {
  return {
    physics: Buffer.alloc(0),
    graphics: graphicsBufferWithStatus(status),
    staticData: Buffer.alloc(0),
  };
}

describe("ACC StatusCheckProcessor", () => {
  test("AC_LIVE passes through", async () => {
    const proc = new StatusCheckProcessor("TEST");
    expect(await proc.process(emptyTriplet(AC_STATUS.AC_LIVE))).toBe(true);
  });

  test("AC_PAUSE passes through (pause must not halt the pipeline)", async () => {
    const proc = new StatusCheckProcessor("TEST");
    expect(await proc.process(emptyTriplet(AC_STATUS.AC_PAUSE))).toBe(true);
  });

  test("AC_OFF halts pipeline (and does not tear reader down)", async () => {
    const proc = new StatusCheckProcessor("TEST");
    expect(await proc.process(emptyTriplet(AC_STATUS.AC_OFF))).toBe(false);
  });

  test("AC_REPLAY halts pipeline", async () => {
    const proc = new StatusCheckProcessor("TEST");
    expect(await proc.process(emptyTriplet(AC_STATUS.AC_REPLAY))).toBe(false);
  });

  test("AC_OFF → AC_LIVE transition resumes pipeline", async () => {
    const proc = new StatusCheckProcessor("TEST");
    expect(await proc.process(emptyTriplet(AC_STATUS.AC_OFF))).toBe(false);
    expect(await proc.process(emptyTriplet(AC_STATUS.AC_LIVE))).toBe(true);
  });
});

describe("ACC lap detector — session lifecycle", () => {
  test("flushStaleLap finalises session after 10s silence", async () => {
    const frames = readAccFrames(ACC_FIXTURE);
    expect(frames.length).toBeGreaterThan(0);

    const first = frames[0];
    const packet = parseAccBuffers(first.physics, first.graphics, first.staticData, {
      carOrdinal: 1,
      trackOrdinal: 1,
    });
    expect(packet).not.toBeNull();

    const db = new CapturingDbAdapter();
    const detector = new LapDetectorAcc({ db });

    await detector.feed(packet!);
    expect(detector.session).not.toBeNull();

    (detector as any)._lastActivePacketTime = Date.now() - 5_000;
    await detector.flushStaleLap();
    expect(detector.session).not.toBeNull();

    (detector as any)._lastActivePacketTime = Date.now() - 11_000;
    await detector.flushStaleLap();
    expect(detector.session).toBeNull();

    await detector.feed(packet!);
    expect(detector.session).not.toBeNull();
    expect(db.sessions.length).toBeGreaterThanOrEqual(2);

    await detector.finalizeCurrentSession();
    expect(detector.session).toBeNull();
  }, { timeout: 30_000 });
});
