import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { _telemetryCacheForTest as cache } from "../../server/db/telemetry-replay-storage";
import type { TelemetryPacket } from "../../shared/telemetry/types";

function stub(id: number, count = 100): TelemetryPacket[] {
  return Array.from({ length: count }, () => ({ __stubId: id })) as unknown as TelemetryPacket[];
}

function stubF1(id: number, count = 100): TelemetryPacket[] {
  return Array.from({ length: count }, () => ({ __stubId: id, f1: {} })) as unknown as TelemetryPacket[];
}

function stubAcc(id: number, count = 100): TelemetryPacket[] {
  return Array.from({ length: count }, () => ({ __stubId: id, acc: {} })) as unknown as TelemetryPacket[];
}

beforeEach(() => {
  cache.clear();
  cache.resetMaxBytes();
});

afterAll(() => cache.resetMaxBytes());

describe("lap telemetry cache (byte-budget LRU)", () => {
  test("set then get returns the same array reference", () => {
    const packets = stub(1);
    cache.set(1, packets);
    expect(cache.get(1)).toBe(packets);
  });

  test("get on missing key returns undefined", () => {
    expect(cache.get(999)).toBeUndefined();
  });

  test("delete removes entry and reclaims bytes", () => {
    const packets = stub(1, 100);
    cache.set(1, packets);
    const before = cache.bytesUsed();
    expect(before).toBeGreaterThan(0);
    cache.delete(1);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.bytesUsed()).toBe(0);
    expect(cache.size()).toBe(0);
  });

  test("re-setting an existing key keeps size stable and updates bytes", () => {
    cache.set(1, stub(1, 100));
    const small = cache.bytesUsed();
    cache.set(1, stub(1, 200));
    expect(cache.size()).toBe(1);
    expect(cache.bytesUsed()).toBeGreaterThan(small);
  });

  test("estimateBytes scales with packet count", () => {
    const a = cache.estimateBytes(stub(1, 100));
    const b = cache.estimateBytes(stub(1, 200));
    expect(b).toBe(a * 2);
  });

  test("estimateBytes is larger for F1 packets than base", () => {
    expect(cache.estimateBytes(stubF1(1, 100))).toBeGreaterThan(cache.estimateBytes(stub(1, 100)));
  });

  test("estimateBytes is larger for ACC packets than base", () => {
    expect(cache.estimateBytes(stubAcc(1, 100))).toBeGreaterThan(cache.estimateBytes(stub(1, 100)));
  });
  test("charges F1 packets at 12000 bytes each", () => {
    expect(cache.estimateBytes(stubF1(1, 100))).toBe(1_200_000);
  });

  test("evicts oldest entry when total bytes exceed budget", () => {
    const oneEntryBytes = cache.estimateBytes(stub(1, 1000));
    cache.setMaxBytes(oneEntryBytes * 2);

    cache.set(1, stub(1, 1000));
    cache.set(2, stub(2, 1000));
    expect(cache.size()).toBe(2);
    expect(cache.keys()).toContain(1);

    cache.set(3, stub(3, 1000));

    expect(cache.size()).toBe(2);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBeDefined();
    expect(cache.get(3)).toBeDefined();
  });

  test("get bumps recency so older entry survives next eviction", () => {
    const oneEntryBytes = cache.estimateBytes(stub(1, 1000));
    cache.setMaxBytes(oneEntryBytes * 2);

    cache.set(1, stub(1, 1000));
    cache.set(2, stub(2, 1000));
    cache.get(1);
    cache.set(3, stub(3, 1000));

    expect(cache.get(1)).toBeDefined();
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(3)).toBeDefined();
  });

  test("setMaxBytes shrinks cache to fit new budget", () => {
    cache.set(1, stub(1, 1000));
    cache.set(2, stub(2, 1000));
    cache.set(3, stub(3, 1000));
    expect(cache.size()).toBe(3);

    const oneEntryBytes = cache.estimateBytes(stub(1, 1000));
    cache.setMaxBytes(oneEntryBytes);

    expect(cache.size()).toBe(1);
    expect(cache.get(3)).toBeDefined();
  });

  test("oversize entry evicts everything else and may not fit", () => {
    const small = cache.estimateBytes(stub(1, 100));
    cache.setMaxBytes(small);

    cache.set(1, stub(1, 100));
    cache.set(2, stub(2, 10000));

    expect(cache.size()).toBe(0);
    expect(cache.bytesUsed()).toBe(0);
  });

  test("clear empties the cache and resets bytes used", () => {
    cache.set(1, stub(1));
    cache.set(2, stub(2));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.bytesUsed()).toBe(0);
  });
  test("stores ordered comparison bodies and returns exact string", () => {
    const body = JSON.stringify({ lapA: 1, lapB: 2 });
    cache.comparisonSet(1, 2, body);
    expect(cache.comparisonGet(1, 2)).toBe(body);
    expect(cache.comparisonGet(2, 1)).toBeUndefined();
  });

  test("comparison entries share byte budget and refresh global recency", () => {
    const oneEntryBytes = cache.estimateBytes(stub(1, 1000));
    cache.setMaxBytes(oneEntryBytes * 2);
    cache.set(1, stub(1, 1000));
    cache.comparisonSet(2, 3, "x".repeat(oneEntryBytes));
    expect(cache.comparisonGet(2, 3)).toBeDefined();
    cache.set(4, stub(4, 1000));
    expect(cache.get(1)).toBeUndefined();
    expect(cache.comparisonGet(2, 3)).toBeDefined();
    expect(cache.get(4)).toBeDefined();
  });

  test("oversize comparison entry is not retained", () => {
    cache.setMaxBytes(10);
    cache.comparisonSet(1, 2, "01234567890");
    expect(cache.comparisonGet(1, 2)).toBeUndefined();
    expect(cache.bytesUsed()).toBe(0);
  });

  test("deleting lap invalidates comparison pairs containing it", () => {
    cache.comparisonSet(1, 2, "a");
    cache.comparisonSet(2, 3, "b");
    cache.comparisonSet(3, 4, "c");
    cache.delete(2);
    expect(cache.comparisonGet(1, 2)).toBeUndefined();
    expect(cache.comparisonGet(2, 3)).toBeUndefined();
    expect(cache.comparisonGet(3, 4)).toBe("c");
  });
  test("stores alignment index independently and preserves both fields", () => {
    const index = { distancesA: [0, 1, 2], distancesB: [0, 2], nominalSpan: 2 };
    const body = "body";
    cache.comparisonAlignmentIndexSet(1, 2, index);
    expect(cache.comparisonAlignmentIndexGet(1, 2)).toBe(index);
    expect(cache.comparisonGet(1, 2)).toBeUndefined();
    cache.comparisonSet(1, 2, body);
    expect(cache.comparisonAlignmentIndexGet(1, 2)).toBe(index);
    expect(cache.comparisonGet(1, 2)).toBe(body);
    expect(cache.bytesUsed()).toBe(Buffer.byteLength(body) + 8 * 5);
  });

  test("preserves body when index is added after body", () => {
    const index = { distancesA: [0, 1], distancesB: [0, 1, 2], nominalSpan: 2 };
    cache.comparisonSet(3, 4, "payload");
    cache.comparisonAlignmentIndexSet(3, 4, index);
    expect(cache.comparisonGet(3, 4)).toBe("payload");
    expect(cache.comparisonAlignmentIndexGet(3, 4)).toBe(index);
  });

  test("alignment index getter refreshes ordered comparison recency", () => {
    const indexBytes = 8 * 20;
    cache.setMaxBytes(indexBytes * 2);
    cache.comparisonAlignmentIndexSet(1, 2, { distancesA: Array(10), distancesB: Array(10), nominalSpan: 1 });
    cache.comparisonAlignmentIndexSet(3, 4, { distancesA: Array(10), distancesB: Array(10), nominalSpan: 1 });
    expect(cache.comparisonAlignmentIndexGet(1, 2)).toBeDefined();
    cache.comparisonAlignmentIndexSet(5, 6, { distancesA: Array(10), distancesB: Array(10), nominalSpan: 1 });
    expect(cache.comparisonAlignmentIndexGet(1, 2)).toBeDefined();
    expect(cache.comparisonAlignmentIndexGet(3, 4)).toBeUndefined();
  });

  test("combined index and body entry evicts as one oversize entry", () => {
    const index = { distancesA: Array(10), distancesB: Array(10), nominalSpan: 1 };
    cache.setMaxBytes(8 * 20 + 3);
    cache.comparisonAlignmentIndexSet(1, 2, index);
    cache.comparisonSet(1, 2, "body");
    expect(cache.comparisonGet(1, 2)).toBeUndefined();
    expect(cache.comparisonAlignmentIndexGet(1, 2)).toBeUndefined();
    expect(cache.bytesUsed()).toBe(0);
  });

});
