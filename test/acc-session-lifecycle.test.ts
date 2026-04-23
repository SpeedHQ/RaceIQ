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
import { StatusCheckProcessor, TripletPipeline } from "../server/games/acc/triplet-pipeline";
import type { TripletProcessor } from "../server/games/acc/triplet-pipeline";
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

class CountingProcessor implements TripletProcessor {
  count = 0;
  async process(): Promise<void> {
    this.count++;
  }
}

describe("ACC TripletPipeline — menu→race resumption (no reader reinit)", () => {
  test("downstream processor runs again after OFF → LIVE without any reconnect", async () => {
    // Regression: StatusCheckProcessor used to call onDisconnect() on AC_OFF,
    // tearing down the TripletAssembler + BufferedAccMemoryReader. Entering a
    // race afterwards never re-invoked downstream processors because the
    // reader stayed dead. This test proves the pipeline alone is sufficient
    // to resume on status flips — no reinit, no new pipeline instance.
    const pipeline = new TripletPipeline();
    const counter = new CountingProcessor();
    pipeline.register(new StatusCheckProcessor("TEST"), counter);

    // User launches game straight to main menu
    await pipeline.process(emptyTriplet(AC_STATUS.AC_OFF));
    expect(counter.count).toBe(0);

    // User enters a race
    await pipeline.process(emptyTriplet(AC_STATUS.AC_LIVE));
    expect(counter.count).toBe(1);

    // User exits to menu again
    await pipeline.process(emptyTriplet(AC_STATUS.AC_OFF));
    await pipeline.process(emptyTriplet(AC_STATUS.AC_REPLAY));
    expect(counter.count).toBe(1);

    // User enters another race — pipeline still alive
    await pipeline.process(emptyTriplet(AC_STATUS.AC_LIVE));
    await pipeline.process(emptyTriplet(AC_STATUS.AC_PAUSE)); // pause counts as in-race
    await pipeline.process(emptyTriplet(AC_STATUS.AC_LIVE));
    expect(counter.count).toBe(4);
  });

  test("StatusCheckProcessor constructor requires no onDisconnect callback", () => {
    // Guard against reintroducing the reader-teardown path. The processor
    // must be constructible with nothing but a label — no disconnect hook.
    const proc = new StatusCheckProcessor("TEST");
    expect(proc).toBeInstanceOf(StatusCheckProcessor);
    expect((proc as unknown as { onDisconnect?: unknown }).onDisconnect).toBeUndefined();
    expect((proc as unknown as { disconnectOnOff?: unknown }).disconnectOnOff).toBeUndefined();
  });
});

describe("ACC lap detector — session re-created on race re-entry", () => {
  test("menu → race → menu → race produces two distinct sessions", async () => {
    // Regression: after the ACC fix, leaving a race to the main menu ends the
    // session (stale timer after 10s of silence). Re-entering a race must
    // immediately create a fresh session — not revive the old one or stay
    // "in waiting" forever.
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

    // Race 1
    await detector.feed(packet!);
    expect(detector.session).not.toBeNull();
    const firstSid = detector.session!.sessionId;

    // User exits to main menu → 10s silence → session finalised
    (detector as any)._lastActivePacketTime = Date.now() - 11_000;
    await detector.flushStaleLap();
    expect(detector.session).toBeNull();

    // User enters a new race → detector must create a fresh session on the
    // very next packet, not leave the app in "Waiting" limbo.
    await detector.feed(packet!);
    expect(detector.session).not.toBeNull();
    expect(detector.session!.sessionId).not.toBe(firstSid);
    expect(db.sessions.length).toBe(2);
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
