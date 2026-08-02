/**
 * Line-spread trace cache (migration v33). The /line-spread endpoint caches its
 * computed trace keyed by tuning session id + a hash of the clean-lap set, so a
 * reopen skips the decode + compute. Verifies the query helpers and that a
 * changed lap set produces a different key (cache miss).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { getLineSpreadCache, setLineSpreadCache, lineSpreadLapSetHash } from "../server/db/line-spread-cache-queries";
import { stopMaintenanceTasks } from "../server/telemetry/live-pipeline"

afterAll(() => stopMaintenanceTasks());

describe("line-spread cache", () => {
  test("hash is order-independent and set-sensitive", () => {
    expect(lineSpreadLapSetHash([3, 1, 2])).toBe(lineSpreadLapSetHash([1, 2, 3]));
    expect(lineSpreadLapSetHash([1, 2, 3])).not.toBe(lineSpreadLapSetHash([1, 2, 4]));
    expect(lineSpreadLapSetHash([1, 2, 3])).not.toBe(lineSpreadLapSetHash([1, 2]));
  });

  test("miss → set → hit round-trips the trace JSON", async () => {
    // Unique session id per run — the .data-test DB persists across runs, so a
    // fixed id would already hold a row from a prior run and fail the miss.
    const sessionId = Math.floor(Math.random() * 1e9) + 1e9;
    const hash = lineSpreadLapSetHash([10, 11, 12]);
    expect(await getLineSpreadCache(sessionId, hash)).toBeNull();

    const traceJson = JSON.stringify({ fracs: [0, 0.5, 1], spreadM: [1, 2, 1], lapCount: 3 });
    await setLineSpreadCache(sessionId, hash, traceJson);
    expect(await getLineSpreadCache(sessionId, hash)).toBe(traceJson);

    // A different lap set is a distinct key — still a miss.
    expect(await getLineSpreadCache(sessionId, lineSpreadLapSetHash([10, 11, 13]))).toBeNull();
  });

  test("upsert replaces an existing trace for the same key", async () => {
    const sessionId = Math.floor(Math.random() * 1e9) + 1e9;
    const hash = lineSpreadLapSetHash([20, 21, 22]);
    await setLineSpreadCache(sessionId, hash, JSON.stringify({ v: 1 }));
    await setLineSpreadCache(sessionId, hash, JSON.stringify({ v: 2 }));
    expect(await getLineSpreadCache(sessionId, hash)).toBe(JSON.stringify({ v: 2 }));
  });
});
