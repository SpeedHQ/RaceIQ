import { describe, expect, test } from "bun:test";
import { GRAPHICS, PHYSICS as ACC_PHYSICS, STATIC } from "../../../server/games/acc/structs";
import {
  GRAPHICS_EVO,
  PHYSICS as AC_EVO_PHYSICS,
  STATIC_EVO,
} from "../../../server/games/ac-evo/structs";
import { OrderedTripletDispatcher } from "../../../server/games/kunos/triplet-assembler";
import type { Triplet } from "../../../server/games/kunos/triplet-pipeline";

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
