import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { _telemetryCacheForTest as cache } from "../server/db/queries";
import type { TelemetryPacket } from "../shared/types";

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
});
