import { describe, expect, spyOn, test } from "bun:test";
import { GRAPHICS, PHYSICS as ACC_PHYSICS, STATIC } from "@raceiq/capture-formats/acc/structs";
import {
  GRAPHICS_EVO,
  PHYSICS as AC_EVO_PHYSICS,
  STATIC_EVO,
} from "@raceiq/capture-formats/ac-evo/structs";
import { OrderedTripletDispatcher, TripletAssembler } from "../../../games/kunos/triplet-assembler";
import type { Triplet } from "../../../games/kunos/triplet-pipeline";
import { getRecordingFrequencyHz, setRecordingFrequencyHz } from "../../../runtime/config/recording-frequency";
import type { IRealtimeKunosMemoryReader } from "../../../games/kunos/memory-reader";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function taggedTriplet(
  tag: number,
  sizes: { physics: number; graphics: number; staticData: number },
): Triplet {
  return {
    physics: Buffer.alloc(sizes.physics, tag),
    graphics: Buffer.alloc(sizes.graphics, tag + 10),
    staticData: Buffer.alloc(sizes.staticData, tag + 20),
  };
}

const accSizes = {
  physics: ACC_PHYSICS.SIZE,
  graphics: GRAPHICS.SIZE,
  staticData: STATIC.SIZE,
};
const acEvoSizes = {
  physics: AC_EVO_PHYSICS.SIZE,
  graphics: GRAPHICS_EVO.SIZE,
  staticData: STATIC_EVO.SIZE,
};

describe("OrderedTripletDispatcher", () => {
  test("retains mixed Kunos triplets exactly once in source order", async () => {
    const firstGate = deferred();
    const accepted = [
      taggedTriplet(1, accSizes),
      taggedTriplet(2, acEvoSizes),
      taggedTriplet(3, accSizes),
    ];
    const processed: Triplet[] = [];
    const dispatcher = new OrderedTripletDispatcher(async (triplet) => {
      if (triplet.physics[0] === 1) await firstGate.promise;
      processed.push({
        physics: Buffer.from(triplet.physics),
        graphics: Buffer.from(triplet.graphics),
        staticData: Buffer.from(triplet.staticData),
      });
    });

    expect(accepted.map((triplet) => dispatcher.enqueue(triplet))).toEqual([
      true,
      true,
      true,
    ]);
    expect(dispatcher.pendingCount).toBe(3);
    expect(processed).toEqual([]);

    firstGate.resolve();
    await dispatcher.close();

    expect(processed.map((triplet) => triplet.physics[0])).toEqual([1, 2, 3]);
    expect(processed).toEqual(accepted);
    expect(dispatcher.pendingCount).toBe(0);
  });

  test("reports one rejection and continues draining later triplets", async () => {
    const errors: unknown[] = [];
    const processed: number[] = [];
    const dispatcher = new OrderedTripletDispatcher(
      async (triplet) => {
        const tag = triplet.physics[0]!;
        if (tag === 1) throw new Error("blocked persistence failed");
        processed.push(tag);
      },
      (error) => errors.push(error),
    );

    dispatcher.enqueue(taggedTriplet(1, accSizes));
    dispatcher.enqueue(taggedTriplet(2, accSizes));
    dispatcher.enqueue(taggedTriplet(3, acEvoSizes));
    await dispatcher.close();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("blocked persistence failed");
    expect(processed).toEqual([2, 3]);
    expect(dispatcher.pendingCount).toBe(0);
  });

  test("close rejects new work and waits for every accepted triplet", async () => {
    const firstGate = deferred();
    const processed: number[] = [];
    const dispatcher = new OrderedTripletDispatcher(async (triplet) => {
      if (triplet.physics[0] === 1) await firstGate.promise;
      processed.push(triplet.physics[0]!);
    });

    expect(dispatcher.enqueue(taggedTriplet(1, accSizes))).toBe(true);
    expect(dispatcher.enqueue(taggedTriplet(2, acEvoSizes))).toBe(true);
    let closed = false;
    const closePromise = dispatcher.close().then(() => {
      closed = true;
    });
    await Promise.resolve();

    expect(closed).toBe(false);
    expect(dispatcher.enqueue(taggedTriplet(3, accSizes))).toBe(false);
    expect(dispatcher.pendingCount).toBe(2);

    firstGate.resolve();
    await closePromise;

    expect(processed).toEqual([1, 2]);
    expect(dispatcher.pendingCount).toBe(0);
  });
});

describe("TripletAssembler running capture ceiling", () => {
  for (const sizes of [accSizes, acEvoSizes]) {
    test(`samples ${sizes.physics}-byte native triplets before buffer work and drains on stop`, async () => {
      const originalFrequency = getRecordingFrequencyHz();
      let nowMs = 0;
      let callback: (() => void) | undefined;
      let bufferReads = 0;
      let sourceIdentity = 0;
      const memoryReader: IRealtimeKunosMemoryReader = {
        start() {},
        async stop() {},
        getDebugBuffers() { return null; },
        getLatestBuffers() {
          bufferReads++;
          const triplet = taggedTriplet(0, sizes);
          triplet.physics.writeInt32LE(sourceIdentity, 0);
          triplet.graphics.writeInt32LE(sourceIdentity, 0);
          return triplet;
        },
      };
      const clock = spyOn(performance, "now").mockImplementation(() => nowMs);
      const wallClock = spyOn(Date, "now").mockImplementation(() => 1_800_000_000_000 + nowMs);
      const timer = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
        callback = fn;
        return 1;
      }) as typeof setInterval);
      const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
      try {
        for (const hz of [50, 100] as const) {
          setRecordingFrequencyHz(hz);
          nowMs = 0;
          bufferReads = 0;
          const received: { identity: number; time: number | undefined }[] = [];
          const gate = deferred();
          const assembler = new TripletAssembler(memoryReader);
          assembler.start(async (triplet) => {
            if (received.length === 0) await gate.promise;
            received.push({ identity: triplet.physics.readInt32LE(0), time: triplet.frameTimeMs });
          });
          for (let tick = 0; tick < 1000; tick++) {
            nowMs = tick * 10;
            sourceIdentity = tick;
            callback!();
          }
          expect(bufferReads).toBe(hz * 10);
          let stopped = false;
          const stopping = assembler.stop().then(() => { stopped = true; });
          await Promise.resolve();
          expect(stopped).toBe(false);
          gate.resolve();
          await stopping;
          expect(received.map((frame) => frame.identity)).toEqual(
            Array.from({ length: hz * 10 }, (_, index) => index * (100 / hz)),
          );
          expect(received.map((frame) => frame.time)).toEqual(
            received.map((frame) => 1_800_000_000_000 + frame.identity * 10),
          );
        }
      } finally {
        clock.mockRestore();
        wallClock.mockRestore();
        timer.mockRestore();
        clear.mockRestore();
        setRecordingFrequencyHz(originalFrequency);
      }
    });
  }
});
