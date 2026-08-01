import { expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { gzipSync } from "zlib";
import {
  deleteSession,
  getSessionResult,
  insertSession,
  updateSessionRawFile,
} from "../server/db/queries";
import { initServerGameAdapters } from "../server/games/init";
import { reconcileSessionResult } from "../server/race-results/reconcile";
import {
  loadRawCaptureIdentity,
  rawCaptureObjectId,
} from "../server/raw-capture-identity";

initServerGameAdapters();

test("raw capture identity is stable across storage compression", async () => {
  const payload = Buffer.from("stable-capture-payload\n".repeat(128));
  const compressed = Buffer.from(gzipSync(payload, { level: 1 }));
  const suffix = `${process.pid}-${Date.now()}`;
  const rawPath = `${process.env.DATA_DIR ?? "."}/raw-capture-identity-${suffix}.bin`;
  const gzipPath = `${rawPath}.gz`;

  await Promise.all([
    Bun.write(rawPath, payload),
    Bun.write(gzipPath, compressed),
  ]);
  try {
    const [raw, gzip] = await Promise.all([
      loadRawCaptureIdentity(rawPath),
      loadRawCaptureIdentity(gzipPath),
    ]);
    expect(raw?.bytes).toEqual(payload);
    expect(gzip?.bytes).toEqual(payload);
    expect(gzip?.contentHash).toBe(raw?.contentHash);
    expect(rawCaptureObjectId(42)).toBe("session:42:raw-capture");
  } finally {
    for (const path of [rawPath, gzipPath]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});

test("race-result raw provenance is stable when capture storage is gzipped", async () => {
  const capture = Buffer.alloc(12);
  const suffix = `${process.pid}-${Date.now()}`;
  const rawPath = `${process.env.DATA_DIR ?? "."}/race-result-provenance-${suffix}.bin`;
  const gzipPath = `${rawPath}.gz`;
  await Promise.all([
    Bun.write(rawPath, capture),
    Bun.write(gzipPath, gzipSync(capture, { level: 9 })),
  ]);

  const sessionId = await insertSession(1, 1, "f1-2025", "race");
  try {
    await updateSessionRawFile(sessionId, rawPath, "test");
    await reconcileSessionResult(sessionId, "f1-2025");
    const rawResult = await getSessionResult(sessionId, "f1-2025");

    await updateSessionRawFile(sessionId, gzipPath, "test");
    await reconcileSessionResult(sessionId, "f1-2025");
    const gzipResult = await getSessionResult(sessionId, "f1-2025");

    expect(rawResult?.provenance.rawInput).toEqual({
      objectId: `session:${sessionId}:raw-capture`,
      contentHash: rawResult?.provenance.rawInput?.contentHash,
    });
    expect(gzipResult?.provenance.rawInput).toEqual(rawResult?.provenance.rawInput);
  } finally {
    await deleteSession(sessionId);
    for (const path of [rawPath, gzipPath]) {
      try {
        unlinkSync(path);
      } catch {}
    }
  }
});
